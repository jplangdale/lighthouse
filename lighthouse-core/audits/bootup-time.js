/**
 * @license Copyright 2017 Google Inc. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with the License. You may obtain a copy of the License at http://www.apache.org/licenses/LICENSE-2.0
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the specific language governing permissions and limitations under the License.
 */
'use strict';

const Audit = require('./audit');
const NetworkRequest = require('../lib/network-request');
const {taskGroups} = require('../lib/task-groups');
const i18n = require('../lib/i18n/i18n.js');
const NetworkRecords = require('../computed/network-records.js');
const MainThreadTasks = require('../computed/main-thread-tasks.js');

const UIStrings = {
  /** Title of a diagnostic audit that provides detail on the time spent executing javascript files during the load. This descriptive title is shown to users when the amount is acceptable and no user action is required. */
  title: 'JavaScript execution time',
  /** Title of a diagnostic audit that provides detail on the time spent executing javascript files during the load. This imperative title is shown to users when there is a significant amount of execution time that could be reduced. */
  failureTitle: 'Reduce JavaScript execution time',
  /** Description of a Lighthouse audit that tells the user that they should reduce the amount of time spent executing javascript and one method of doing so. This is displayed after a user expands the section to see more. No character length limits. 'Learn More' becomes link text to additional documentation. */
  description: 'Consider reducing the time spent parsing, compiling, and executing JS. ' +
    'You may find delivering smaller JS payloads helps with this. [Learn ' +
    'more](https://developers.google.com/web/tools/lighthouse/audits/bootup).',
  /** Label for the total time column in a data table; entries will be the number of milliseconds spent executing per resource loaded by the page. */
  columnTotal: 'Total',
  /** Label for a time column in a data table; entries will be the number of milliseconds spent evaluating script for every script loaded by the page. */
  columnScriptEval: 'Script Evaluation',
  /** Label for a time column in a data table; entries will be the number of milliseconds spent parsing script files for every script loaded by the page. */
  columnScriptParse: 'Script Parse',
  /** A message displayed in a Lighthouse audit result warning that Chrome extensions on the user's system substantially affected Lighthouse's measurements and instructs the user on how to run again without those extensions. */
  chromeExtensionsWarning: 'Chrome extensions negatively affected this page\'s load performance. ' +
    'Try auditing the page in incognito mode or from a Chrome profile without extensions.',
};

const str_ = i18n.createMessageInstanceIdFn(__filename, UIStrings);

class BootupTime extends Audit {
  /**
   * @return {LH.Audit.Meta}
   */
  static get meta() {
    return {
      id: 'bootup-time',
      title: str_(UIStrings.title),
      failureTitle: str_(UIStrings.failureTitle),
      description: str_(UIStrings.description),
      scoreDisplayMode: Audit.SCORING_MODES.NUMERIC,
      requiredArtifacts: ['traces', 'URL'],
    };
  }

  /**
   * @return {LH.Audit.ScoreOptions & {thresholdInMs: number}}
   */
  static get defaultOptions() {
    return {
      // see https://www.desmos.com/calculator/rkphawothk
      // <500ms ~= 100, >2s is yellow, >3.5s is red
      scorePODR: 600,
      scoreMedian: 3500,
      thresholdInMs: 50,
    };
  }

  /**
   * @param {LH.Artifacts.NetworkRequest[]} records
   */
  static getJavaScriptURLs(records) {
    /** @type {Set<string>} */
    const urls = new Set();
    for (const record of records) {
      if (record.resourceType === NetworkRequest.TYPES.Script) {
        urls.add(record.url);
      }
    }

    return urls;
  }

  /**
   * @param {LH.Artifacts.TaskNode[]} tasks
   * @param {Set<string>} jsURLs
   * @param {string} finalURL
   * @return {Map<string, Object<string, number>>}
   */
  static getExecutionTimingsByURL(tasks, jsURLs, finalURL) {
    /** @type {Map<string, Object<string, number>>} */
    const result = new Map();

    for (const task of tasks) {
      const jsURL = task.attributableURLs.find(url => jsURLs.has(url));
      const fallbackURL = task.attributableURLs[0];
      let attributableURL = jsURL || fallbackURL;
      // If we can't find what URL was responsible for this execution, just attribute it to the root page.
      if (!attributableURL || attributableURL === 'about:blank') attributableURL = finalURL;

      const timingByGroupId = result.get(attributableURL) || {};
      const originalTime = timingByGroupId[task.group.id] || 0;
      timingByGroupId[task.group.id] = originalTime + task.selfTime;
      result.set(attributableURL, timingByGroupId);
    }

    return result;
  }

  /**
   * @param {LH.Artifacts} artifacts
   * @param {LH.Audit.Context} context
   * @return {Promise<LH.Audit.Product>}
   */
  static async audit(artifacts, context) {
    const finalURL = artifacts.URL.finalUrl;
    const settings = context.settings || {};
    const trace = artifacts.traces[BootupTime.DEFAULT_PASS];
    const devtoolsLog = artifacts.devtoolsLogs[BootupTime.DEFAULT_PASS];
    const networkRecords = await NetworkRecords.request(devtoolsLog, context);
    const tasks = await MainThreadTasks.request(trace, context);
    const multiplier = settings.throttlingMethod === 'simulate' ?
      settings.throttling.cpuSlowdownMultiplier : 1;

    const jsURLs = BootupTime.getJavaScriptURLs(networkRecords);
    const executionTimings = BootupTime.getExecutionTimingsByURL(tasks, jsURLs, finalURL);

    let hadExcessiveChromeExtension = false;
    let totalBootupTime = 0;
    const results = Array.from(executionTimings)
      .map(([url, timingByGroupId]) => {
        // Add up the totalExecutionTime for all the taskGroups
        let totalExecutionTimeForURL = 0;
        for (const [groupId, timespanMs] of Object.entries(timingByGroupId)) {
          timingByGroupId[groupId] = timespanMs * multiplier;
          totalExecutionTimeForURL += timespanMs * multiplier;
        }

        const scriptingTotal = timingByGroupId[taskGroups.scriptEvaluation.id] || 0;
        const parseCompileTotal = timingByGroupId[taskGroups.scriptParseCompile.id] || 0;

        // Add up all the JavaScript time of shown URLs
        if (totalExecutionTimeForURL >= context.options.thresholdInMs) {
          totalBootupTime += scriptingTotal + parseCompileTotal;
        }

        hadExcessiveChromeExtension = hadExcessiveChromeExtension ||
          (url.startsWith('chrome-extension:') && scriptingTotal > 100);

        return {
          url: url,
          total: totalExecutionTimeForURL,
          // Highlight the JavaScript task costs
          scripting: scriptingTotal,
          scriptParseCompile: parseCompileTotal,
        };
      })
      .filter(result => result.total >= context.options.thresholdInMs)
      .sort((a, b) => b.total - a.total);


    // TODO: consider moving this to core gathering so you don't need to run the audit for warning
    if (hadExcessiveChromeExtension) {
      context.LighthouseRunWarnings.push(str_(UIStrings.chromeExtensionsWarning));
    }

    const summary = {wastedMs: totalBootupTime};

    const headings = [
      {key: 'url', itemType: 'url', text: str_(i18n.UIStrings.columnURL)},
      {key: 'total', granularity: 1, itemType: 'ms', text: str_(UIStrings.columnTotal)},
      {key: 'scripting', granularity: 1, itemType: 'ms', text: str_(UIStrings.columnScriptEval)},
      {key: 'scriptParseCompile', granularity: 1, itemType: 'ms',
        text: str_(UIStrings.columnScriptParse)},
    ];

    const details = BootupTime.makeTableDetails(headings, results, summary);

    const score = Audit.computeLogNormalScore(
      totalBootupTime,
      context.options.scorePODR,
      context.options.scoreMedian
    );

    return {
      score,
      rawValue: totalBootupTime,
      displayValue: totalBootupTime > 0 ?
        str_(i18n.UIStrings.seconds, {timeInMs: totalBootupTime}) : '',
      details,
    };
  }
}

module.exports = BootupTime;
module.exports.UIStrings = UIStrings;
