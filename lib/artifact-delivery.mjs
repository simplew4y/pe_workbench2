import path from 'node:path';

export function artifactDeliveryFindings(answer,receipts=[]) {
 const saved=receipts.filter(r=>r.saved===true),findings=[];
 if(!saved.length)return findings;
 for(const paragraph of answer.split(/\n\s*\n/)) {
  const plain=paragraph.replace(/[*`]/g,'');
  const allDenied=/环境(?:不能|无法)写入文件/.test(plain) ||
   /所有文件|全部文件|报告[和与及].{0,25}JSON/i.test(plain) && /均未(?:落盘|保存|写入)|全部未(?:保存|写入)|都未(?:保存|写入)/.test(plain) ||
   /报告\s*[和与及]\s*(?:状态\s*)?JSON[^。；\n]*(?:但|均|都)\s*未(?:落盘|保存|写入)/i.test(plain);
  const namedDenied=plain.split(/[，；。\n]/).some(clause=>saved.some(r=>clause.includes(path.basename(r.path)) && /未(?:落盘|保存|写入)/.test(clause)));
  if(allDenied || namedDenied)findings.push({rule:'artifact_status',severity:'error',excerpt:paragraph,sourceText:paragraph,
   message:'保存声明与本轮实际文件回执不一致',expected:saved.map(r=>r.path+'已写入并回读一致').join('；')});
 }
 return findings;
}

export function artifactDeliverySummary(receipts=[]) {
 const saved=receipts.filter(r=>r.saved===true);
 return saved.length ? '**文件交付**：'+saved.map(r=>`[${path.basename(r.path)}](${encodeURI(r.path)}) 已保存`).join('；')+'。文件保存状态不代表其中研究判断均已通过核验。' : '';
}
