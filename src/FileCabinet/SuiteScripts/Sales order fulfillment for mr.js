/**
 * @NApiVersion 2.1
 * @NScriptType Suitelet
 */

define([ 'N/task', 'N/runtime', 'N/log'], 
    function(task, runtime, log) {

    function onRequest(context) {

        try {

            var currentUser = runtime.getCurrentUser();

            log.audit(   'Launching Map/Reduce',   currentUser.name +  ' | ' +  currentUser.email );
            var mapreduceTask = task.create({
                taskType: task.TaskType.MAP_REDUCE
            });

            mapreduceTask.scriptId ='customscript_so_fulfillment';
            mapreduceTask.deploymentId =  'customdeploy_so_fulfillment';

            mapreduceTask.params = {

                custscript_user_id : currentUser.id,
                custscript_user_email : currentUser.email
            };

            var taskId = mapreduceTask.submit();

            log.audit('MR Submitted', taskId   );
            context.response.write(
                'Map/Reduce Started Successfully' +
                '<br><br>' +
                'Task ID : ' + taskId
            );

        } catch(e) {

            log.error( 'Suitelet Error', e.message );
            context.response.write(
                'Error : ' + e.message
            );
        }
    }

    return {
        onRequest: onRequest
    };
});