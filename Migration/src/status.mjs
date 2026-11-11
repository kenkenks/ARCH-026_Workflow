export function summarize(scan){
  const progress={},warnings={};for(const a of scan.assets){progress[a.progress]=(progress[a.progress]||0)+1;for(const w of a.warnings)warnings[w]=(warnings[w]||0)+1;}
  return {registered:scan.assets.length,progress,warnings,unregistered:scan.unregistered.length,skip:scan.assets.filter(a=>a.skip).map(a=>a.id),next:scan.assets.filter(a=>!a.skip&&a.classification==='ACTIVE').map(a=>({id:a.id,reasons:[...a.warnings,...a.reasons]}))};
}
