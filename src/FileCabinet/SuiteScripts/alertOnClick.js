/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 */
define(['N/log', 'N/ui/serverWidget'],
    /**
 * @param{log} log
 * @param{serverWidget} serverWidget
 */
    (log, serverWidget) => {
        /**
         * Defines the function definition that is executed before record is loaded.
         * @param {Object} scriptContext
         * @param {Record} scriptContext.newRecord - New record
         * @param {string} scriptContext.type - Trigger type; use values from the context.UserEventType enum
         * @param {Form} scriptContext.form - Current form
         * @param {ServletRequest} scriptContext.request - HTTP request information sent from the browser for a client action only.
         * @since 2015.2
         */
        const beforeLoad = (context) => {
            try{

                log.debug('Entry','beforeLoad Triggered');
                
                // Only add the button in VIEW mode
                if (context.type !== context.UserEventType.VIEW) {
                    log.debug('Context','SO is not in view mode');
                    return;
                }

                // Attaches CS file to form to handle button clicks
                context.form.clientScriptModulePath = 'SuiteScripts/alertOnClickAction.js';

                // Add button to the form
                context.form.addButton({
                    id:'custpage_my_alert_button',
                    label:'Alert',
                    functionName: 'showMyAlert'
                });

                log.debug('beforeLoad', 'Button added in view mode');
            } catch(e){
                log.error('beforeLoad ERROR', e.message);
            }
        }

        return {beforeLoad};

    });
