const core = require('@actions/core');
const github = require('@actions/github');
const utils = require('./utils.js');

async function run() {
  const status = {}; // status of intermediate steps
  const states = {}; // things to remember between pre/main/post

  const context = github.context;

  const token = core.getInput('token');
  core.setSecret(token);

  const octokit = github.getOctokit(token);

  try {
    utils.showTitle('Verification Setup Phase');

    // must do or setup state is lost
    utils.restoreStates(states);

    // -----------------------------------------------
    core.startGroup('Displaying environment setup...');

    await utils.checkExec('java', {
      param: ['--version'],
      title: 'Displaying Java runtime version',
      error: 'Unable to display Java runtime version'
    });

    await utils.checkExec('javac', {
      param: ['--version'],
      title: 'Displaying Java compiler version',
      error: 'Unable to display Java compiler version'
    });

    await utils.checkExec('mvn', {
      param: ['--version'],
      title: 'Displaying Maven version',
      error: 'Unable to display Maven version'
    });

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    // -----------------------------------------------
    core.startGroup('Updating Maven dependencies...');

    status.maven = await utils.checkExec('mvn', {
      param: ['-f', `${utils.mainDir}/pom.xml`, '-ntp', 'dependency:go-offline'],
      error: 'Updating returned non-zero exit code',
    });

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    // -----------------------------------------------
    core.startGroup('Compiling project main code...');

    status.mainCompile = await utils.checkExec('mvn', {
      param: ['-ntp', '"-DcompileOptionXlint=-Xlint:all"', '"-DcompileOptionXdoclint=-Xdoclint:all/private"', '-DcompileOptionFail=false', '-Dmaven.compiler.showWarnings=true', 'compile'],
      title: 'Compiling project main code',
      error: 'Compiling returned non-zero exit code',
      chdir: `${utils.mainDir}/`
    });

    await utils.checkExec('ls', {
      param: ['-m', `${utils.mainDir}/target/classes`],
      title: 'Listing main class files',
      error: 'Unable to list main class directory',
    });

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    // -----------------------------------------------
    core.startGroup('Compiling project test code...');

    status.testCompile = await utils.checkExec('mvn', {
      param: ['-ntp', '-DcompileOptionXlint="-Xlint:none"', '-DcompileOptionXdoclint="-Xdoclint:none"', '-DcompileOptionFail="false"', '-Dmaven.compiler.showWarnings="true"', 'test-compile'],
      title: 'Compiling project test code',
      error: 'Compiling returned non-zero exit code',
      chdir: `${utils.mainDir}/`
    });

    await utils.checkExec('ls', {
      param: ['-m', `${utils.mainDir}/target/test-classes`],
      title: 'Listing test class files',
      error: 'Unable to list test class directory',
    });

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    utils.showTitle('Verification Testing Phase');

    // -----------------------------------------------
    core.startGroup('Running verification tests...');

    const tester = states.tester;
    const project = states.project;
    const version = states.version;

    status.verify = await utils.checkExec('mvn', {
      param: ['-ntp', `-Dtest=${tester}`, '-DexcludedGroups=none()|!verify', 'test'],
      title: 'Running verification tests',
      chdir: `${utils.mainDir}/`
    });

    states.passed = status.verify === 0;
    states.message = states.passed ? `All Project ${project} verification tests of ${version} passed!` : `One or more Project ${project} verification tests of ${version} failed.`;

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    // -----------------------------------------------
    if (states.passed !== true) {
      core.startGroup('Running debug tests...');

      status.debug = await utils.checkExec('mvn', {
        param: ['-ntp', `-Dtest=${tester}`, '-DexcludedGroups=verify', 'test'],
        title: 'Running debug tests',
        chdir: `${utils.mainDir}/`
      });

      throw new Error(states.message);

      core.info('');
      core.endGroup();
    }
    else {
      utils.showSuccess(states.message);
    }
    // -----------------------------------------------
  }
  catch (error) {
    utils.showError(`${error.message}\n`); // show error in group
    core.endGroup();  // end group

    // displays outside of group; always visible
    core.setFailed(`Unable to verify project. ${error.message}`);
  }
  finally {
    utils.showTitle('Verification Cleanup Phase');
    utils.saveStates(states);

    core.startGroup('Logging verify status...');
    core.info(`status: ${JSON.stringify(status)}`);
    core.info(`states: ${JSON.stringify(states)}`);
    core.endGroup();

    utils.checkWarnings('"Test Project"');
  }
}

run();
