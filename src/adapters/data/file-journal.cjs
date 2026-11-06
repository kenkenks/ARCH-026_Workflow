'use strict';
const fs=require('node:fs');
class FileMigrationJournal {
  constructor(file){
    try{this.fd=fs.openSync(file,'wx');}catch{throw Object.assign(new Error('JOURNAL_UNAVAILABLE'),{code:'JOURNAL_UNAVAILABLE'});}
    this.closed=false;this.failed=false;this.sequence=0;
  }
  async append(event){
    if(this.closed||this.failed)throw Object.assign(new Error('JOURNAL_UNAVAILABLE'),{code:'JOURNAL_UNAVAILABLE'});
    try{
      fs.writeFileSync(this.fd,JSON.stringify({...event,sequence:++this.sequence})+'\n','utf8');
      fs.fsyncSync(this.fd);
    }catch{this.failed=true;throw Object.assign(new Error('JOURNAL_UNAVAILABLE'),{code:'JOURNAL_UNAVAILABLE'});}
  }
  close(){if(this.closed)return;try{fs.closeSync(this.fd);this.closed=true;}catch{throw Object.assign(new Error('JOURNAL_UNAVAILABLE'),{code:'JOURNAL_UNAVAILABLE'});}}
}
module.exports={FileMigrationJournal};
