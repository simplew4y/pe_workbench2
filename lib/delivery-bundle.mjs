import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {insideProjectRealRoot} from './workspace-path.mjs';
const hash=body=>crypto.createHash('sha256').update(body).digest('hex');

// Legacy states remain readable. Versioned states require the commit marker
// and both exact file hashes, including when an external writer drops delivery.
export function deliveryBundleIssue(root,statePath,state) {
  const directory=path.posix.dirname(statePath);
  const manifestPath=path.join(root,directory,'delivery-manifest.json');
  if(!state?.delivery && !fs.existsSync(manifestPath))return null;
  try {
    if(fs.existsSync(path.join(root,directory,'.delivery-lock')))return '报告交付正在更新，暂不可启用监控';
    const read=relative=>{
      const absolute=path.resolve(root,relative || '');
      if(!insideProjectRealRoot(root,absolute))throw Error('交付引用越出项目');
      return fs.readFileSync(absolute);
    };
    const manifest=JSON.parse(read(path.posix.join(directory,'delivery-manifest.json')));
    if(!state?.delivery || manifest.version!==state.delivery.version || manifest.state?.path!==statePath ||
      manifest.report?.path!==state.delivery.reportPath || manifest.report?.sha256!==state.delivery.reportHash ||
      manifest.state.sha256!==hash(read(statePath)) || manifest.report.sha256!==hash(read(manifest.report.path)))
      return '报告与状态的交付版本或内容不一致，监控已暂停';
    if(state.delivery.status==='pending_validation')return '报告与状态已对齐，监控条件待核实';
    if(state.delivery.status!=='aligned' || state.delivery.trackingEnabled!==true || manifest.state.trackingEnabled!==true)
      return '正文与候选状态待核对，监控尚未启用';
    return null;
  } catch {return '交付清单缺失或无法校验，监控已暂停';}
}
