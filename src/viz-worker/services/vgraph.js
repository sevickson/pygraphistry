import url from 'url';
import { loadDataset } from './datasets';
import { Observable } from 'rxjs';
import { cache as Cache } from '@graphistry/common';
import { load as _loadVGraph } from '../simulator/libs/VGraphLoader';

const unpackers = {
    'null': _loadVGraph,
    'vgraph': _loadVGraph,
    'default': _loadVGraph,
    'jsonMeta': loadVGraphJSON
};

export function loadVGraph(view, config, s3Cache = new Cache(config.LOCAL_CACHE_DIR, config.LOCAL_CACHE)) {
    return Observable
        .of({ view, loaded: false })
        .expand(loadAndUnpackVGraph(config, s3Cache))
        .takeLast(1)
        .mergeMap(loadDataFrameAndUpdateBuffers)
}

function loadAndUnpackVGraph(config, s3Cache) {
    return function loadAndUnpackVGraph({ view, loaded }) {

        if (loaded === true) {
            return Observable.empty();
        }

        const { nBody } = view;
        const { dataset } = nBody;
        const unpack = unpackers[dataset.type];

        return loadDataset(dataset, config, s3Cache)
            .map((buffer) => ({ metadata: dataset, body: buffer }))
            .mergeMap(
                (tuple) => unpack(nBody, tuple, config, s3Cache),
                (tuple, nBodyOrTuple) => {
                    let loaded = false;
                    if (nBodyOrTuple.loaded === false) {
                        view.nBody = nBodyOrTuple.nBody;
                    } else {
                        loaded = true;
                        view.nBody = nBodyOrTuple;
                    }
                    return { view, loaded };
                }
            );
    }
}

function loadVGraphJSON(nBody, { metadata: dataset, body: buffer }, config, s3Cache) {
    const json = JSON.parse(buffer.toString('utf8'));
    const datasource = json.datasources[0];
    nBody.dataset = {
        ...dataset,
        ...datasource, type: 'vgraph',
        url: url.parse(datasource.url)
    };
    return Observable.of({ nBody, loaded: false })
}

function loadDataFrameAndUpdateBuffers({ view }) {

    const { nBody } = view;
    const { simulator, simulator: { dataframe, layoutAlgorithms }} = nBody;
    // Load into dataframe data attributes that rely on the simulator existing.
    const inDegrees = dataframe.getHostBuffer('backwardsEdges').degreesTyped;
    const outDegrees = dataframe.getHostBuffer('forwardsEdges').degreesTyped;
    const unsortedEdges = dataframe.getHostBuffer('unsortedEdges');

    dataframe.loadDegrees(outDegrees, inDegrees);
    dataframe.loadEdgeDestinations(unsortedEdges);

    view.scene = assignHintsToScene(view.scene, dataframe);
    view.expressionTemplates = createExpressionTemplates(dataframe);

    // Tell all layout algorithms to load buffers from dataframe, now that
    // we're about to enable ticking
    return Observable.merge(
        ...layoutAlgorithms.map((algo) =>
            Observable.from(algo.updateDataframeBuffers(simulator))
        )
    )
    .toArray()
    .mapTo(view);
}

function assignHintsToScene(scene, dataframe) {

    const MAX_SIZE_TO_ALLOCATE = 2000000;
    const numEdges = dataframe.numEdges();
    const numPoints = dataframe.numPoints();

    scene.edges.elements = Math.min(numEdges, MAX_SIZE_TO_ALLOCATE);
    scene.points.elements = Math.min(numPoints, MAX_SIZE_TO_ALLOCATE);

    return scene;
}

function createExpressionTemplates(dataframe) {

    const templates = {}, allColumnsByType = {};
    const columnsByComponentType = dataframe.getColumnsByType(true);

    /*        { point, edge } */
    for (const componentType in columnsByComponentType) {

        const columnsByName = columnsByComponentType[componentType];
        const columnsForComponent = allColumnsByType[componentType] || (
            allColumnsByType[componentType] = {});

        for (const columnName in columnsByName) {

            const column = columnsByName[columnName];
            columnsForComponent[columnName] = column;

            // If column.name is different than the columnName key,
            // insert the column with the name as well.
            if (column.name !== columnName && !columnsForComponent[column.name]) {
                columnsForComponent[column.name] = column;
            }
        }
    }

    const { point: pointColumns, edge: edgeColumns } = allColumnsByType;

    for (const columnName in pointColumns) {

        const column = pointColumns[columnName];
        const attribute = columnName.indexOf('point') === 0 ? columnName : `point:${columnName}`;

        if (edgeColumns.hasOwnProperty(columnName)) {

            const edgeColumn = edgeColumns[columnName];
            const edgeAttribute = columnName.indexOf('edge') === 0 ? columnName : `edge:${columnName}`;

            templates[attribute] = {
                attribute,
                name: columnName,
                dataType: column.type,
                componentType: 'point'
            };

            templates[edgeAttribute] = {
                name: columnName,
                attribute: edgeAttribute,
                dataType: edgeColumn.type,
                componentType: 'edge'
            };

        } else if (!templates.hasOwnProperty(columnName)) {
            templates[attribute] = {
                attribute,
                name: columnName,
                dataType: column.type,
                componentType: 'point'
            };
        }
    }

    for (const columnName in edgeColumns) {
        const column = edgeColumns[columnName];
        const attribute = columnName.indexOf('edge') === 0 ? columnName : `edge:${columnName}`;
        if (!templates.hasOwnProperty(columnName)) {
            templates[attribute] = {
                attribute,
                name: columnName,
                dataType: column.type,
                componentType: 'edge'
            };
        }
    }

    return Object
        .keys(templates)
        .map((key) => templates[key]);
}