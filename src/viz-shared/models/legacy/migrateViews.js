import flake from 'simpleflake';
import { ref as $ref } from 'falcor-json-graph';

export function migrateViews(workbook) {

    if (workbook.viewsById) {
        return workbook;
    }

    const viewsById = {};
    const viewsList = { length: 0 };
    const workbookViews = workbook.views;

    let currentView = workbookViews[workbook.currentView || 'default'];
    let currentViewIndex = 0;

    for (const viewId in workbookViews) {

        if (!workbookViews.hasOwnProperty(viewId)) {
            continue;
        }

        const view = workbookViews[viewId];

        if (!currentView) {
            currentView = view;
            currentViewIndex = viewsList.length;
        } else if (currentView === view) {
            currentViewIndex = viewsList.length;
        }

        if (!view.id) {
            view.id = flake().toString('hex')
        }

        viewsById[view.id] = view;
        viewsList[viewsList.length++] = $ref(`workbooksById['${workbook.id}'].viewsById['${view.id}']`);
    }

    if (!currentView) {
        currentView = createView(workbook.id);
        currentViewIndex = viewsList.length;
        viewsById[currentView.id] = currentView;
        viewsList[viewsList.length++] = $ref(`workbooksById['${workbook.id}'].viewsById['${currentView.id}']`);
    }

    viewsList.current = $ref(`workbooksById['${workbook.id}'].views['${currentViewIndex}']`);

    workbook.views = viewsList;
    workbook.viewsById = viewsById;

    return workbook;
}
