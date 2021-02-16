const core = require('@actions/core');
const github = require('@actions/github');
const exec = require('@actions/exec');
const cache = require('@actions/cache');
const utils = require('./utils.js');

async function run() {
  const status = {}; // status of intermediate steps
  const states = {}; // things to remember between pre/main/post

  const token = core.getInput('token');
  core.setSecret(token);

  const octokit = github.getOctokit(token);

  try {
    // -----------------------------------------------
    core.startGroup('Parsing project details...');

    const owner = github.context.repo.owner;
    const repo = github.context.repo.repo;

    states.owner    = owner;
    states.mainRepo = `${owner}/${repo}`;
    states.testRepo = `${owner}/${utils.testDir}`;

    core.info('');
    core.info(`Project main repository: ${states.mainRepo}`);
    core.info(`Project test repository: ${states.testRepo}`);

    const ref = github.context.ref;
    const tokens = ref.split('/');
    const version = tokens[tokens.length - 1];

    const regex = /^v([1-4])\.(\d+)\.(\d+)$/;
    const matched = version.match(regex);

    states.project = '*';

    if (matched !== null && matched.length === 4) {
      states.project = +matched[1];

      if (states.project === 3) {
        states.project = +matched[2] === 0 ? '3a' : '3b';
      }
    }
    else {
      core.info('Using user input for project number.');
      const valid = new Set(['1', '2', '3a', '3b', '4']);
      const project = core.getInput('project');

      if (valid.has(project)) {
        states.project = project;
      }
      else {
        core.info(`Input ${project} is invalid; using default.`);
      }
    }

    states.version = version;
    states.tester = `Project${states.project}Test*`;

    core.info(`Project number: ${states.project}`);
    core.info(`Project version: ${states.version}`);
    core.info(`Project test class: ${states.tester}`);

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    // -----------------------------------------------
    core.startGroup(`Cloning project main code...`);

    status.mainClone = await utils.checkExec('git', {
      param: ['clone', '--depth', '1', '-c', 'advice.detachedHead=false',
        '--no-tags', '--branch', states.version,
        `https://github-actions:${token}@github.com/${states.mainRepo}`, utils.mainDir],
      title: `Cloning ${states.version} from ${states.mainRepo} into ${utils.mainDir}`,
      error: `Failed cloning ${states.mainRepo} repository`
    });

    await utils.checkExec('ls', {
      param: ['-m', `${utils.mainDir}/src/main/java`],
      title: 'Listing project main code',
      error: 'Unable to list main directory'
    });

    core.info('');
    core.endGroup();
    // -----------------------------------------------

    // -----------------------------------------------
    core.startGroup(`Checking for project test cache...`);

    try {
      core.info(`\nChecking ${utils.testDir} commits...`);
      const commits = await octokit.repos.listCommits({
        owner: states.owner,
        repo: utils.testDir,
        per_page: 1
      });

      const hash = commits.data[0].sha;
      core.info(`Found commit: ${hash}`);
      states.testKey = `${utils.testDir}-${hash}`;
    }
    catch(error) {
      throw new Error(`Unable to list ${utils.testDir} commits (${error.message.toLowerCase()}).`);
    }

    core.info(`\nAttempting to restore ${utils.testDir} cache...`);
    status.testCache = await cache.restoreCache(
      [utils.testDir],       // paths to restore
      states.testKey,        // current key
      [`${utils.testDir}-`]  // other keys to restore
    );

    core.info(`Returned cache: ${status.testCache}`);
    states.testCache = status.testCache;

    if (status.testCache != undefined && states.testKey != states.testCache) {
      core.info('Old cache detected; pulling latest changes.');

      await utils.checkExec('git', {
        param: ['status'],
        title: `Checking ${utils.testDir} git status`,
        error: `Unable to check ${utils.testDir} git status`,
        chdir: `${utils.testDir}/`
      });

      await utils.checkExec('git', {
        param: ['pull', '--ff-only'],
        title: `Pulling latest ${utils.testDir} version`,
        error: `Unable to pull latest ${utils.testDir} version`,
        chdir: `${utils.testDir}/`
      });
    }

    core.info('');
    core.endGroup();

    // check for warnings AFTER ending group
    if (!status.testCache) {
      utils.showWarning(`Unable to restore cache: ${states.testKey}`);
    }
    // -----------------------------------------------

    // -----------------------------------------------
    if (status.testCache == undefined) {
      core.startGroup('Cloning project test code...');

      status.testClone = await utils.checkExec('git', {
        param: ['clone', '--depth', '1', '--no-tags', `https://github-actions:${token}@github.com/${states.testRepo}`, utils.testDir],
        title: `Cloning ${states.testRepo} into ${utils.testDir}`,
        error: `Failed cloning ${states.testRepo} repository`
      });

      await utils.checkExec('ls', {
        param: ['-m', `${utils.testDir}/src/test/java`],
        title: 'Listing project test code',
        error: 'Unable to list test directory'
      });

      core.info('');
      core.endGroup();
    }
    // -----------------------------------------------

    // -----------------------------------------------
    core.startGroup(`Checking for Maven cache...`);

    core.info('\nHashing pom.xml file...');
    let hash = '';
    status.sha256 = await exec.exec('sha256sum',
      [`${utils.mainDir}/pom.xml`], {
        ignoreReturnCode: true,
        listeners: {
          stdout: (data) => {hash += data.toString();}
        }
      });

    if (status.sha256 !== 0) {
      throw new Error(`Unable to hash ${utils.mainDir}/pom.xml file (${sha256}).`);
    }

    const runner = process.env.RUNNER_OS;
    states.mavenKey = `${runner}-m2-${hash.split(' ')[0]}`;

    core.info(`\nAttempting to restore Maven cache...`);
    status.mavenCache = await cache.restoreCache(
      ['~/.m2'],         // paths to restore
      states.mavenKey,   // current key
      [`${runner}-m2-`]  // other keys to restore
    );

    core.info(`Returned cache: ${status.mavenCache}`);
    states.mavenCache = status.mavenCache;

    core.info('');
    core.endGroup();

    // check for warnings AFTER ending group
    if (!status.mavenCache) {
      utils.showWarning(`Unable to restore cache: ${states.mavenKey}`);
    }
    // -----------------------------------------------

    // save states
    utils.saveStates(states);
  }
  catch (error) {
    utils.showError(`${error}\n`); // show error in group
    core.endGroup();  // end group

    // displays outside of group; always visible
    core.setFailed(`Setup failed. ${error.message}`);
  }
  finally {
    core.startGroup('Logging setup status...');
    core.info(`status: ${JSON.stringify(status)}`);
    core.info(`states: ${JSON.stringify(states)}`);
    core.endGroup();

    utils.checkWarnings('"Pre Test Project"');
  }
}

run();
