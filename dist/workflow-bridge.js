let handlers=null;
export function connectInbox(value){handlers=value;}
export function inboxRecord(id){return handlers?.get(id);}
export function saveInboxComparison(context,invoice,po,result){if(!handlers)throw Error('Inbox is unavailable.');return handlers.match(context,invoice,po,result);}
export function saveInboxCase(context,c){if(!handlers)throw Error('Inbox is unavailable.');return handlers.case(context,c);}
export function backToInbox(){document.querySelector('[data-page=invoices]').click();}
