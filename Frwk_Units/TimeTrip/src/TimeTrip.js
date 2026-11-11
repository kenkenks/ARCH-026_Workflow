'use strict';
const {CJobForm}=require('@arch026/workflow');
const {createApplication}=require('./TimeApplicationCore.js');
const {createSystemContext}=require('./SystemContext.js');
const time=require('./TimeTripCore.js');
const {runSteps}=require('@arch026/core/flow');

/** Job execution records a configured source; reads never depend on Job state. */
class TimeTrip extends CJobForm {
  #application;
  #setting;
  #dao;
  #dependencies;
  constructor(dao, setting={enabled:false}, dependencies={}) {
    super('TimeTrip');
    this.#dependencies={...dependencies};
    this.#application=createApplication(dao,this.#dependencies);
    // Capture input by value, not caller-owned mutable configuration.
    this.#setting=structuredClone(setting);
    this.#dao=dao;
  }
  collect(){return structuredClone(this.#setting);}
  async record(setting) {
    const result=await this.#application.saveTimeTravel(setting);
    if(!result.ok)throw Object.assign(new Error(result.message),{code:'INVALID_TIME_SETTING'});
  }
  #readDate(fn){const dao=this.#dao,dependencies=this.#dependencies;return runSteps((function*(){return fn(yield createSystemContext(dao,dependencies));})());}
  now(){return this.#readDate(time.now);}
  today(){return this.#readDate(time.today);}
  targetMonth(){return this.#readDate(time.targetMonth);}
  getSystemContext(){return this.#application.getSystemContext();}
  getTimeTravel(){return this.#application.getTimeTravel();}
  saveTimeTravel(input){return this.#application.saveTimeTravel(input);}
}
module.exports={TimeTrip};
