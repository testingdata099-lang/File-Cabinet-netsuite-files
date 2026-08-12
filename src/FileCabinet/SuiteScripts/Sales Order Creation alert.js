/**
 * @NApiVersion 2.1
 * @NScriptType ClientScript
 * @NModuleScope Public
 */
define(['N/runtime'],
function(runtime) {
    
        function pageInit(context) {
        
            try {
                 if (context.mode === 'create') {
                     var user = runtime.getCurrentUser();
                     var userName = user.name || user.email || 'User';
                     alert('Hello, ' + userName);
                 }
            }
            catch (e) {
                alert('Hello, User');
            }
    

    }

        return {
         pageInit: pageInit
    };
    
});
