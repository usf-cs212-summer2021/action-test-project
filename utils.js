const core = require('@actions/core');
const github = require('@actions/github');
const exec = require('@actions/exec');
const cache = require('@actions/cache');
const style = require('ansi-styles');

// track warnings
exports.warnings = 0;

exports.mainDir = 'project-main';   // otherwise project-username
exports.testDir = 'project-tests';  // must match pom.xml and repository name

/*
 * Checks the exit code after executing a command and throws
 * an error if it is non-zero. Useful since exec.exec triggers
 * failure on non-zero exit codes by default.
 *
 * command: the command to exec
 * settings.param: the parameters to use (array)
 * settings.title: the title to output before executing
 * settings.error: the error message to use for non-zero exit code
 *                 (if not specified, no error is thrown)
 * settings.chdir: working directory to use
 */
exports.checkExec = async function(command, settings) {
  const options = {ignoreReturnCode: true};

  if ('chdir' in settings) {
    options.cwd = settings.chdir;
  }

  const param = 'param' in settings ? settings.param : [];

  if ('title' in settings) {
    core.info(`\n${settings.title}...`);
  }

  const result = await exec.exec(command, param, options);

  if ('error' in settings && result !== 0) {
    throw new Error(`${settings.error} (${result}).`);
  }

  return result;
}

exports.saveStates = function(states) {
  core.startGroup('Saving state...');

  for (const state in states) {
    core.saveState(state, states[state]);
    core.info(`Saved value ${states[state]} for state ${state}.`);
  }

  core.saveState('keys', JSON.stringify(Object.keys(states)));
  core.endGroup();
}

exports.restoreStates = function(states) {
  core.startGroup('Restoring state...');

  const keys = JSON.parse(core.getState('keys'));
  core.info(`Loaded keys: ${keys}`);

  for (const key of keys) {
    states[key] = core.getState(key);
    core.info(`Restored value ${states[key]} for state ${key}.`);
  }

  core.endGroup();
  return states;
}

exports.showTitle = function(text) {
  core.info(`\n${style.cyan.open}${style.bold.open}${text}${style.bold.close}${style.cyan.close}`);
}

function styleText(color, bgColor, label, text) {
  core.info(`${style[bgColor].open}${style.black.open}${style.bold.open}${label}:${style.bold.close}${style.black.close}${style[bgColor].close} ${style[color].open}${text}${style[color].close}`);
}

function incrementWarnings() {
  const past = core.getState('warnings');
  console.info(`was ${past}`);
  const next = past ? parseInt(past) + 1 : 1;
  console.info(`now ${next}`);
  core.saveState('warnings', next);
}

exports.showError = function(text) {
  styleText('red', 'bgRed', 'Error', text);
}

exports.showSuccess = function(text) {
  styleText('green', 'bgGreen', 'Success', text);
}

exports.showWarning = function(text) {
  exports.warnings++;
  styleText('yellow', 'bgYellow', 'Warning', text);
}

exports.checkWarnings = function(phase) {
  if (exports.warnings > 1) {
    core.warning(`There were ${exports.warnings} warnings in the ${phase} phase. View the run log for details.`);
  }
  else if (exports.warnings == 1) {
    core.warning(`There was ${exports.warnings} warning in the ${phase} phase. View the run log for details.`);
  }
}
