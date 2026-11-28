// Host publication is not a model tool event. Use the same index/broadcast
// callback only after the final bundle has committed, including the state JSON.
export async function publishReportWithMaterials(publish,onMaterialSaved,entry,outcome,question) {
 const delivered=await publish(outcome,question);
 if(!delivered.reportPublication?.saved)return delivered;
 const pending=[];
 for(const receipt of [delivered.deliveryBundle?.report,delivered.deliveryBundle?.state].filter(Boolean)) {
  try {await onMaterialSaved(entry,'write',{path:receipt.path,publication:'final_delivery',sha256:receipt.sha256});}
  catch {pending.push(receipt.path);}
 }
 // Index failure does not roll back an already committed financial artifact or
 // pretend it was never saved. Keep the distinct failed projection observable.
 return {...delivered,materialIndex:{status:pending.length?'pending':'updated',pending}};
}
