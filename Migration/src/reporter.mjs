export function report(scan){
  const cell=x=>String(x).replaceAll('|','\\|').replaceAll('\n',' ');
  return ['# Migration進捗レポート','','| ID | コピー先 | Unit | 状態 | 分類 | 警告 | 未完了・確認理由 | Skip |','|---|---|---|---|---|---|---|---|',...scan.assets.map(a=>`| ${[a.id,a.destination,a.unit,a.progress,a.classification,a.warnings.join(', ')||'—',a.reasons.join(', ')||'—',a.skip?'YES':'NO'].map(cell).join(' | ')} |`),'','## 未登録ファイル',...scan.unregistered.map(p=>'- '+p),'','自動検出の依存範囲はRegistryのinputs・testsと検証実行器に限定。依存宣言外の変更は保証しない。',''].join('\n');
}
