/**
 * @NApiVersion 2.x
 * @NScriptType ClientScript
 * @NModuleScope SameAccount
 */
define(['N/currentRecord', 'N/record', 'N/log'],
/**
 * @param {currentRecord} currentRecordModule
 * @param {record} recordModule
 * @param {log} logModule
 */
function(currentRecordModule, recordModule, logModule) {

    /**
     * Function to be executed after page is initialized.
     *
     * @param {Object} scriptContext
     * @param {Record} scriptContext.currentRecord - Current form record
     * @param {string} scriptContext.mode - The mode in which the record is being accessed (create, copy, or edit)
     * @since 2015.2
     */
    function pageInit(scriptContext) {
        // Optional: log to verify script is loaded
        // logModule.debug('Page Init', 'Script loaded in mode: ' + scriptContext.mode);
    }

    /**
     * Function to be executed when field is changed.
     *
     * @param {Object} scriptContext
     * @param {Record} scriptContext.currentRecord - Current form record
     * @param {string} scriptContext.sublistId - Sublist name
     * @param {string} scriptContext.fieldId - Field name
     * @param {number} scriptContext.lineNum - Line number. Will be undefined if not a sublist or matrix field
     * @param {number} scriptContext.columnNum - Line number. Will be undefined if not a matrix field
     * @since 2015.2
     */
    function fieldChanged(scriptContext) {
        try {
            // Only react when "entity" field changes
            if (scriptContext.fieldId !== 'entity') return;

            var orderRecord = scriptContext.currentRecord;
            var customerId = orderRecord.getValue({ fieldId: 'entity' });

            if (!customerId) {
                logModule.debug('fieldChanged', 'No customer selected');
                return;
            }

            var customerRecord = recordModule.load({
                type: recordModule.Type.CUSTOMER,
                id: customerId
            });

            var phoneValue = customerRecord.getValue({ fieldId: 'phone' });
            var defaultPhoneNumber = '1234567890';

            if (phoneValue) {
                orderRecord.setValue({
                    fieldId: 'custbody_alt_phonenumber',
                    value: phoneValue,
                    ignoreFieldChange: true
                });

                logModule.debug('fieldChanged', 'Set custbody_alt_phonenumber = ' + phoneValue);
            } else {
                // Update customer phone if empty
                customerRecord.setValue({
                    fieldId: 'phone',
                    value: defaultPhoneNumber
                });
                customerRecord.save();

                orderRecord.setValue({
                    fieldId: 'custbody_alt_phonenumber',
                    value: defaultPhoneNumber,
                    ignoreFieldChange: true
                });

                logModule.debug('fieldChanged', 'Set default custbody_alt_phonenumber = ' + defaultPhoneNumber);
            }
        } catch (error) {
            logModule.error({
                title: 'Customer Phone Update Error',
                details: error.message || 'Unknown error'
            });
        }
    }

    return {
        pageInit: pageInit,
        fieldChanged: fieldChanged
    };
});
