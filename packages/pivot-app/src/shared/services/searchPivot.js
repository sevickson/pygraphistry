import { Observable } from 'rxjs';
import { listTemplates } from '.';
import _ from 'underscore';
import logger from 'pivot-shared/logger';
import VError from 'verror';

const log = logger.createLogger(__filename);

const templatesMap = listTemplates();

export function searchPivot({ loadPivotsById, pivotIds, loadInvestigationsById, investigationId }) {
    return loadPivotsById({ pivotIds: pivotIds }).mergeMap(({ app, pivot }) => {
        const template = templatesMap[pivot.pivotTemplate.value[1]];

        return loadInvestigationsById({
            investigationIds: [investigationId]
        }).flatMap(({ investigation }) => {
            // Load other pivots in investigation
            const pivotIds = investigation.pivots.map(({ value }) => value[1]);
            const context = loadPivotsById({ pivotIds })
                .map(({ pivot }) => {
                    return pivot;
                })
                .toArray();

            return context.flatMap(pivots => {
                const pivotCache = pivots.reduce((result, pivot) => {
                    result[pivot.id] = pivot;
                    return result;
                }, {});

                return template
                    .searchAndShape({
                        app,
                        pivot,
                        pivotCache,
                        time: (investigation.time || {}).value
                    })
                    .do(({ pivot }) => {
                        pivot.status = { ok: true, searching: false };
                        if (pivot.isPartial) {
                            _.extend(pivot.status, {
                                info: true,
                                title: 'Results are not exhaustive!',
                                message:
                                    'The search hit the maximum time allowed. Showing only the most recent events found.'
                            });
                        }
                    })
                    .catch(e =>
                        Observable.throw(
                            e instanceof VError
                                ? Observable.throw(e)
                                : new VError.WError(
                                      {
                                          name: 'Failed search',
                                          cause: e instanceof Error ? e : new Error(e)
                                      },
                                      'Search failed for pivot: "%s"',
                                      pivot.id
                                  )
                        )
                    );
            });
        });
    });
}