/**
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define([
    'N/search',
    'N/record',
    'N/message',
    'N/runtime',
    'N/log'
], function(search, record, message, runtime, log) {

    var FALLBACK_AUTHOR   = 33885;  // replace with your employee internal ID
    var FULFILLABLE_TYPES = ['InvtPart', 'Assembly', 'Kit'];

    // ── HELPER: get location from SO header or customer subsidiary ──
    function getLocationForSO(soRec, soNumber) {

        // step 1 read from SO header location
        var headerLocation = soRec.getValue({ fieldId: 'location' });

        if (headerLocation) {
            log.audit('LOCATION', 'SO=' + soNumber + ' | Source=SO Header | LOC=' + headerLocation);
            return headerLocation;
        }

        try {

            var customerId   = soRec.getValue({ fieldId: 'entity'     });
            var subsidiaryId = soRec.getValue({ fieldId: 'subsidiary' });

            log.audit('LOCATION',
                'SO='            + soNumber    +
                ' | Customer='   + customerId  +
                ' | Subsidiary=' + subsidiaryId
            );

            // step 2 search location by SO subsidiary
            if (subsidiaryId) {

                var subDetails = search.lookupFields({
                    type   : search.Type.SUBSIDIARY,
                    id     : subsidiaryId,
                    columns: ['name']
                });

                log.audit('LOCATION', 'SO=' + soNumber + ' | Subsidiary=' + subDetails.name);

                var locSearch  = search.create({
                    type   : search.Type.LOCATION,
                    filters: [
                        ['subsidiary', 'anyof', subsidiaryId],
                        'AND',
                        ['isinactive', 'is',    'F'          ]
                    ],
                    columns: [
                        search.createColumn({ name: 'internalid' }),
                        search.createColumn({ name: 'name'       })
                    ]
                });

                var locResults = locSearch.run().getRange({ start: 0, end: 1 });

                if (locResults && locResults.length > 0) {
                    var subLocation = locResults[0].getValue('internalid');
                    log.audit('LOCATION',
                        'SO='   + soNumber   +
                        ' | Source=Subsidiary Location' +
                        ' | LOC=' + subLocation
                    );
                    return subLocation;
                }
            }

            // step 3 search location by customer subsidiary
            if (customerId) {

                var customerDetails = search.lookupFields({
                    type   : search.Type.CUSTOMER,
                    id     : customerId,
                    columns: ['subsidiary']
                });

                var custSubsidiary = customerDetails.subsidiary && customerDetails.subsidiary.length > 0
                                   ? customerDetails.subsidiary[0].value
                                   : null;

                if (custSubsidiary) {

                    var custLocSearch = search.create({
                        type   : search.Type.LOCATION,
                        filters: [
                            ['subsidiary', 'anyof', custSubsidiary],
                            'AND',
                            ['isinactive', 'is',    'F'            ]
                        ],
                        columns: [
                            search.createColumn({ name: 'internalid' }),
                            search.createColumn({ name: 'name'       })
                        ]
                    });

                    var custLocResults = custLocSearch.run().getRange({ start: 0, end: 1 });

                    if (custLocResults && custLocResults.length > 0) {
                        var custLocation = custLocResults[0].getValue('internalid');
                        log.audit('LOCATION',
                            'SO='   + soNumber    +
                            ' | Source=Customer Subsidiary Location' +
                            ' | LOC=' + custLocation
                        );
                        return custLocation;
                    }
                }
            }

        } catch (e) {
            log.error('LOCATION ERROR', 'SO=' + soNumber + ' | ' + e.message);
        }

        log.error('LOCATION', 'SO=' + soNumber + ' | No location found');
        return null;
    }

    // ── HELPER: get first available serial or lot number ────────────
    function getFirstInventoryNumber(itemId, locationId, isSerialized) {
        try {
            var invSearch = search.create({
                type   : isSerialized
                       ? search.Type.SERIAL_INVENTORY_ITEM
                       : search.Type.LOT_NUMBERED_INVENTORY_ITEM,
                filters: [
                    ['item',              'anyof',       itemId    ],
                    'AND',
                    ['location',          'anyof',       locationId],
                    'AND',
                    ['status',            'anyof',       'Good'    ],
                    'AND',
                    ['quantityavailable', 'greaterthan', 0         ]
                ],
                columns: [
                    search.createColumn({ name: 'internalid'        }),
                    search.createColumn({ name: 'inventorynumber'   }),
                    search.createColumn({ name: 'quantityavailable' })
                ]
            });

            var firstNum = invSearch.run().getRange({ start: 0, end: 1 });

            if (firstNum && firstNum.length > 0) {
                var invNumber = firstNum[0].getValue('inventorynumber');
                log.audit('AUTO INV NUMBER',
                    'Item=' + itemId + ' | Loc=' + locationId + ' | Number=' + invNumber
                );
                return invNumber;
            }

        } catch (e) {
            log.error('AUTO INV NUMBER ERROR', e.message);
        }
        return null;
    }

    // ── STAGE 1: getInputData ────────────────────────────────────────
    function getInputData() {

        log.audit('MR START', 'Fetching Pending Fulfillment SOs with fulfillable items');

        return search.create({
            type    : search.Type.SALES_ORDER,
            filters : [
                ['mainline',  'is',    'T'                             ],
                'AND',
                ['status',    'anyof', 'SalesOrd:B'                    ],
                'AND',
               ['internalid', 'anyof',
                  ['146952','146955','146956','146962','146960','146965','146967','146969','146970','146953']
]
            ],

            columns : [
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'tranid'     })
            ]
        });
    }

    // ── STAGE 2: map ─────────────────────────────────────────────────
    function map(context) {

        var result   = JSON.parse(context.value);
        var soId     = result.id;
        var soNumber = result.values.tranid;

        log.audit('MAP START', 'SO=' + soNumber + ' | ID=' + soId);

        try {

            var soRec     = record.load({ type: record.Type.SALES_ORDER, id: soId, isDynamic: false });
            var lineCount = soRec.getLineCount({ sublistId: 'item' });

            // check if SO has any fulfillable lines
            var requiresFulfillment = false;

            for (var i = 0; i < lineCount; i++) {

                var itemType       = soRec.getSublistValue({ sublistId: 'item', fieldId: 'itemtype',          line: i });
                var isClosed       = soRec.getSublistValue({ sublistId: 'item', fieldId: 'isclosed',           line: i });
                var qtyFulfillable = soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantityfulfillable', line: i })
                                  || soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantitybackordered',  line: i })
                                  || soRec.getSublistValue({ sublistId: 'item', fieldId: 'quantity',             line: i });

                log.audit('SO LINE',
                    'SO='        + soNumber       +
                    ' | LINE='   + i              +
                    ' | TYPE='   + itemType       +
                    ' | QTY='    + qtyFulfillable +
                    ' | CLOSED=' + isClosed
                );

                if (FULFILLABLE_TYPES.indexOf(itemType) !== -1 &&
                    !isClosed &&
                    Number(qtyFulfillable) > 0) {
                    requiresFulfillment = true;
                    break;
                }
            }

            if (!requiresFulfillment) {
                log.audit('MAP SKIP', 'SO=' + soNumber + ' | No fulfillable lines');
                context.write({
                    key  : soId,
                    value: JSON.stringify({ soNumber: soNumber, ifId: 'N/A', invId: '', error: 'No fulfillable lines' })
                });
                return;
            }

            // validate subsidiary vs items
            var soSubsidiary    = soRec.getValue({ fieldId: 'subsidiary' });
            var subsidiaryValid = true;

            for (var v = 0; v < lineCount; v++) {
                var lineItemId = soRec.getSublistValue({ sublistId: 'item', fieldId: 'item', line: v });
                if (!lineItemId) continue;
                try {
                    var itemSub   = search.lookupFields({ type: search.Type.ITEM, id: lineItemId, columns: ['subsidiary'] });
                    if (itemSub.subsidiary && itemSub.subsidiary.length > 0) {
                        var validSubs = itemSub.subsidiary.map(function(s) { return s.value; });
                        if (validSubs.indexOf(String(soSubsidiary)) === -1) {
                            log.error('SUBSIDIARY MISMATCH', 'SO=' + soNumber + ' | ITEM=' + lineItemId);
                            subsidiaryValid = false;
                            break;
                        }
                    }
                } catch (subErr) { log.debug('SUB CHECK', subErr.message); }
            }

            if (!subsidiaryValid) {
                context.write({
                    key  : soId,
                    value: JSON.stringify({ soNumber: soNumber, ifId: 'FAILED', invId: 'FAILED', error: 'Subsidiary mismatch' })
                });
                return;
            }

            var ifId = '';

            try {

                var ifRec = record.transform({
                    fromType     : record.Type.SALES_ORDER,
                    fromId       : soId,
                    toType       : record.Type.ITEM_FULFILLMENT,
                    isDynamic    : true,
                    defaultValues: { disabletriggers: true }
                });

                ifRec.setValue({ fieldId: 'shipstatus', value: 'C' });

                // get default location from SO header or subsidiary
                var defaultLocation = getLocationForSO(soRec, soNumber);

                if (defaultLocation) {
                    ifRec.setValue({ fieldId: 'location', value: defaultLocation });
                    log.audit('HEADER LOCATION SET', 'SO=' + soNumber + ' | LOC=' + defaultLocation);
                }

                var ifLineCount = ifRec.getLineCount({ sublistId: 'item' });
                var validLines  = 0;

                for (var j = 0; j < ifLineCount; j++) {

                    try {

                        var ifItemType = ifRec.getSublistValue({ sublistId: 'item', fieldId: 'itemtype', line: j });
                        var ifItemId   = ifRec.getSublistValue({ sublistId: 'item', fieldId: 'item',     line: j });

                        ifRec.selectLine({ sublistId: 'item', line: j });

                        // skip non fulfillable items
                        if (FULFILLABLE_TYPES.indexOf(ifItemType) === -1) {
                            log.audit('LINE SKIP', 'SO=' + soNumber + ' | LINE=' + j + ' | TYPE=' + ifItemType);
                            ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                            ifRec.commitLine({ sublistId: 'item' });
                            continue;
                        }

                        // set quantity
                        var qty = ifRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity' });
                        if (!qty || Number(qty) === 0) {
                            qty = ifRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'orderquantity' }) || 1;
                            ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: qty });
                        }

                        // ── LOCATION ──────────────────────────────────

                        // read from IF line first
                        var lineLocation = ifRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'location' });

                        // if missing use SO header or subsidiary location
                        if (!lineLocation) {
                            lineLocation = getLocationForSO(soRec, soNumber);
                        }

                        log.audit('LOCATION FINAL', 'SO=' + soNumber + ' | LINE=' + j + ' | LOC=' + lineLocation);

                        // if no location found skip the line
                        if (!lineLocation) {
                            log.error('LINE SKIP', 'SO=' + soNumber + ' | LINE=' + j + ' | No location found');
                            ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: false });
                            ifRec.commitLine({ sublistId: 'item' });
                            continue;
                        }

                        ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'location',    value: Number(lineLocation) });
                        ifRec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'itemreceive', value: true                 });

                        // ── INVENTORY DETAIL ──────────────────────────

                        var invDetailAvail = ifRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'inventorydetailavail' });
                        var invDetailReq   = ifRec.getCurrentSublistValue({ sublistId: 'item', fieldId: 'inventorydetailreq'   });

                        if (invDetailAvail || invDetailReq) {

                            try {

                                var invDetail       = ifRec.getCurrentSublistSubrecord({ sublistId: 'item', fieldId: 'inventorydetail' });
                                var assignmentCount = invDetail.getLineCount({ sublistId: 'inventoryassignment' });

                                log.audit('INV DETAIL', 'SO=' + soNumber + ' | LINE=' + j + ' | ASSIGNMENTS=' + assignmentCount);

                                if (assignmentCount > 0) {

                                    // commit existing assignments from SO
                                    for (var a = 0; a < assignmentCount; a++) {
                                        invDetail.selectLine({ sublistId: 'inventoryassignment', line: a });
                                        invDetail.commitLine({ sublistId: 'inventoryassignment' });
                                    }
                                    log.audit('INV DETAIL', 'SO=' + soNumber + ' | LINE=' + j + ' | COMMITTED EXISTING');

                                } else {

                                    // read item type for serial or lot
                                    var itemDet      = search.lookupFields({ type: search.Type.ITEM, id: ifItemId, columns: ['isserialitem', 'islotitem'] });
                                    var isSerialized = itemDet.isserialitem;
                                    var isLotItem    = itemDet.islotitem;

                                    log.audit('INV DETAIL',
                                        'SO='        + soNumber     +
                                        ' | LINE='   + j            +
                                        ' | SERIAL=' + isSerialized +
                                        ' | LOT='    + isLotItem
                                    );

                                    if (isSerialized) {

                                        // auto select first serial number per unit
                                        for (var s = 0; s < qty; s++) {
                                            var serialNumber = getFirstInventoryNumber(ifItemId, lineLocation, true);
                                            invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                                            if (serialNumber) {
                                                invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', value: serialNumber });
                                                log.audit('INV DETAIL', 'SO=' + soNumber + ' | SERIAL=' + serialNumber);
                                            }
                                            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: 1      });
                                            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'status',   value: 'Good' });
                                            invDetail.commitLine({ sublistId: 'inventoryassignment' });
                                        }

                                    } else if (isLotItem) {

                                        // auto select first lot number
                                        var lotNumber = getFirstInventoryNumber(ifItemId, lineLocation, false);
                                        invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                                        if (lotNumber) {
                                            invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'receiptinventorynumber', value: lotNumber });
                                            log.audit('INV DETAIL', 'SO=' + soNumber + ' | LOT=' + lotNumber);
                                        }
                                        invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: qty    });
                                        invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'status',   value: 'Good' });
                                        invDetail.commitLine({ sublistId: 'inventoryassignment' });

                                    } else {

                                        // regular inventory item
                                        invDetail.selectNewLine({ sublistId: 'inventoryassignment' });
                                        invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'quantity', value: qty    });
                                        invDetail.setCurrentSublistValue({ sublistId: 'inventoryassignment', fieldId: 'status',   value: 'Good' });
                                        invDetail.commitLine({ sublistId: 'inventoryassignment' });
                                    }

                                    log.audit('INV DETAIL', 'SO=' + soNumber + ' | LINE=' + j + ' | AUTO ASSIGNED');
                                }

                            } catch (invErr) {
                                log.error('INV DETAIL ERROR', 'SO=' + soNumber + ' | LINE=' + j + ' | ' + invErr.message);
                            }

                        } else {
                            log.audit('NO INV DETAIL NEEDED', 'SO=' + soNumber + ' | LINE=' + j + ' | ITEM=' + ifItemId);
                        }

                        ifRec.commitLine({ sublistId: 'item' });
                        validLines++;

                        log.audit('LINE SUCCESS',
                            'SO='      + soNumber     +
                            ' | LINE=' + j            +
                            ' | ITEM=' + ifItemId     +
                            ' | LOC='  + lineLocation +
                            ' | QTY='  + qty
                        );

                    } catch (lineErr) {
                        log.error('LINE FAILED', 'SO=' + soNumber + ' | LINE=' + j + ' | ' + lineErr.message);
                        try { ifRec.cancelLine({ sublistId: 'item' }); } catch (e) {}
                    }
                }

                if (validLines > 0) {
                    ifId = ifRec.save({ enableSourcing: false, ignoreMandatoryFields: true });
                    log.audit('IF CREATED', 'SO=' + soNumber + ' | IF=' + ifId);
                } else {
                    log.audit('MAP SKIP', 'SO=' + soNumber + ' | No valid IF lines');
                }

            } catch (ifErr) {
                log.error('MAP FAILED', 'SO=' + soNumber + ' | IF ERROR=' + ifErr.message);
            }

            context.write({
                key  : soId,
                value: JSON.stringify({
                    soNumber: soNumber,
                    ifId    : ifId || 'FAILED',
                    invId   : '',
                    error   : ifId ? '' : 'IF not created'
                })
            });

        } catch (e) {
            log.error('MAP FAILED', 'SO=' + soNumber + ' | ERROR=' + e.message);
            context.write({
                key  : soId,
                value: JSON.stringify({ soNumber: soNumber, ifId: 'FAILED', invId: 'FAILED', error: e.message })
            });
        }
    }

    // ── STAGE 3: reduce ──────────────────────────────────────────────
    function reduce(context) {

        var data     = JSON.parse(context.values[0]);
        var soId     = context.key;
        var soNumber = data.soNumber;

        if (data.ifId === 'FAILED') {
            log.error('INVOICE SKIPPED', 'SO=' + soNumber + ' | IF NOT CREATED');
            context.write({ key: soId, value: JSON.stringify(data) });
            return;
        }

        try {

            // check if invoice already exists for this SO
            var existingInv = search.create({
                type   : search.Type.INVOICE,
                filters: [['createdfrom', 'anyof', soId]],
                columns: ['internalid']
            }).run().getRange({ start: 0, end: 1 });

            if (existingInv.length > 0) {
                data.invId = existingInv[0].getValue('internalid');
                log.audit('INVOICE EXISTS', 'SO=' + soNumber + ' | INV=' + data.invId);
                context.write({ key: soId, value: JSON.stringify(data) });
                return;
            }

            log.debug('REDUCE START', 'SO=' + soNumber + ' | Creating Invoice');

            var invRec = record.transform({
                fromType     : record.Type.SALES_ORDER,
                fromId       : soId,
                toType       : record.Type.INVOICE,
                isDynamic    : true,
                defaultValues: { disabletriggers: true }
            });

            var invLineCount = invRec.getLineCount({ sublistId: 'item' });
            log.debug('REDUCE', 'SO=' + soNumber + ' | Invoice Lines=' + invLineCount);

            if (invLineCount === 0) {
                data.invId = 'FAILED';
                data.error = 'Invoice has no lines';
            } else {
                var invId  = invRec.save({ enableSourcing: false, ignoreMandatoryFields: true });
                data.invId = invId;
                log.audit('INVOICE CREATED', 'SO=' + soNumber + ' | INV=' + invId);
            }

        } catch (e) {
            data.invId = 'FAILED';
            data.error = e.message;
            log.error('INVOICE FAILED', 'SO=' + soNumber + ' | NAME=' + e.name + ' | MSG=' + e.message);
        }

        context.write({ key: soId, value: JSON.stringify(data) });
    }

    // ── STAGE 4: summarize ───────────────────────────────────────────
    function summarize(summary) {

        log.audit('MR SUMMARIZE', 'Collecting results');

        var rows   = [];
        var passed = 0;
        var failed = 0;

        summary.output.iterator().each(function(key, value) {
            var row = JSON.parse(value);
            rows.push(row);
            if (row.ifId !== 'FAILED' && row.invId !== 'FAILED') { passed++; } else { failed++; }
            return true;
        });

        summary.mapSummary.errors.iterator().each(function(key, err) {
            log.error('MAP ERROR', 'Key=' + key + ' | ' + err);
            return true;
        });

        summary.reduceSummary.errors.iterator().each(function(key, err) {
            log.error('REDUCE ERROR', 'Key=' + key + ' | ' + err);
            return true;
        });

        log.audit('MR SUMMARIZE',
            'Total=' + rows.length + ' | Passed=' + passed + ' | Failed=' + failed
        );

        // get current user who ran the script
        var currentUser = runtime.getCurrentUser();
        var authorId    = (currentUser.id === -4 || currentUser.id === '-4')
                        ? FALLBACK_AUTHOR
                        : currentUser.id;

        log.audit('MR SUMMARIZE', 'Sending message to employee ID: ' + authorId);

        // send report to NetSuite Messages/Communication tab
        try {

            message.send({
                authorId   : authorId,
                recipientId: authorId,       // send to same user who ran the script
                subject    : 'Sales Order Fulfillment and Billing Report',
                body       : buildReport(rows, passed, failed)
            });

            log.audit('MR SUMMARIZE', 'Message sent to employee: ' + authorId);

        } catch (msgErr) {

            log.error('MESSAGE FAILED', msgErr.message);
            // fallback — log report to execution log
            log.audit('MR REPORT', buildReport(rows, passed, failed));
        }

        log.audit('MR SUMMARIZE', 'Script Finished');
    }

    // ── build the report ─────────────────────────────────────────────
    function buildReport(rows, passed, failed) {

        var line   = '-------------------------------------------------------------';
        var report = [];

        report.push('Sales Order Fulfillment and Billing Report');
        report.push(line);
        report.push('Total: ' + rows.length + ' | Passed: ' + passed + ' | Failed: ' + failed);
        report.push(line);
        report.push(padDot('Sales Order', 30) + padDot('Item Fulfillment', 30) + padDot('Invoice', 30));
        report.push(line);

        rows.forEach(function(row) {
            report.push(
                padDot(row.soNumber || '-',      30) +
                padDot(row.ifId     || 'FAILED', 30) +
                padDot(row.invId    || 'FAILED', 30)
            );
        });

        report.push(line);
        report.push('End of Report');

        return report.join('\n');
    }

    function padDot(value, width) {
        var str = String(value || '');
        while (str.length < width) str += '.';
        return str;
    }

    return {
        getInputData : getInputData,
        map          : map,
        reduce       : reduce,
        summarize    : summarize
    };

});