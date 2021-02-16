const core = require('@actions/core');
const github = require('@actions/github');
const exec = require('@actions/exec');
const cache = require('@actions/cache');
const glob = require('@actions/glob');
const style = require('ansi-styles');

function customError(text) {
  // similar error output without the extra annotation
  core.info(`${style.red.open}${style.bold.open}Error:${style.bold.close}${style.red.close} ${text}`);
}

function customHeading(heading) {
  core.info(`\n${style.cyan.open}${style.bold.open}${heading}${style.bold.close}${style.cyan.close}`);
}

function parseRepo(text, user) {
  // "user/repo" or just "repo"
  const tokens = text.split('/', 2);

  const last = tokens.pop(); // usually repo
  const next = tokens.pop(); // usually user

  return {
    repo: last,
    user: next ? next : user,
    full: next ? `${next}/${last}` : `${user}/${last}`
  };
}

// refs/tags/v#.#.# or refs/heads/main
function parseRef(ref) {
  const tokens = ref.split('/');

  if (tokens.length !== 3 || tokens[0] !== "refs") {
    throw new Error(`Unable to parse ref: ${ref}`);
  }

  const project = {
    type: tokens[1],
    version: tokens[2]
  };

  const regex = /^v([1-4])\.(\d+)\.(\d+)$/;
  const matched = project.version.match(regex);

  if (matched !== null && matched.length === 4) {
    project.number = matched[1];

    if (project.number === 3) {
      project.number = +matched[2] === 0 ? '3a' : '3b';
    }
  }
  else {
    project.number = '*'; // run all project tests
  }

  project.tester = `Project${project.number}Test*`;
  return project;
}

// exec sets failure for non-zero status codes
// this avoids that and throws an error instead
async function checkExec(command, settings) {
  const options = {
    ignoreReturnCode: true
  }

  if ('chdir' in settings) {
    options.cwd = settings.chdir;
  }

  core.info(`\n${settings.title}...`);
  const result = await exec.exec(command, settings.param, options);

  if (settings.error && result !== 0) {
    throw new Error(`${settings.error} (${result}).`);
  }

  return result;
}

// level: notice, warning, or failure
// conclusion: action_required, cancelled, failure, neutral, success, skipped, stale, or timed_out
async function addAnnotation(context, octokit, title, summary, level, conclusion) {
  try {
    const annotation = await octokit.checks.create({
      owner: context.payload.organization.login,
      repo: context.payload.repository.name,
      name: title,
      head_sha: context.sha,
      status: 'completed',
      conclusion: conclusion,
      output: {
        title: title,
        summary: summary,
        annotations: [
          {
             path: `.github`,
             start_line: 1,
             end_line: 1,
             annotation_level: level,
             message: summary,
             title: title
          }
        ]
      }
    });

    core.debug(`Annotation added at: ${annotation.data.html_url}`);
  }
  catch (error) {
    core.warning(`Unable to add "${title}" annotation. ${error.message}`);
  }
}

async function setup(context, octokit, args, token) {
  // -----------------------------------------------
  core.startGroup('Parsing project details...');

  try {
    // pull information from github context
    args.user = context.payload.organization.login;

    // get main and test repository details
    args.main = parseRepo(core.getInput('main'), args.user);
    args.test = parseRepo(core.getInput('test'), args.user);

    // directories to keep main versus test repositories
    args.main.dir = 'project-main';
    args.test.dir = 'project-tests'; // must match pom.xml

    args.os = core.getInput('runner');
    args.project = parseRef(context.ref);

    await checkExec('java', {
      param: ['--version'],
      title: 'Checking Java runtime version',
      error: 'Unable to verify Java runtime version'
    });

    await checkExec('javac', {
      param: ['--version'],
      title: 'Checking Java compiler version',
      error: 'Unable to verify Java compiler version'
    });

    await checkExec('mvn', {
      param: ['--version'],
      title: 'Checking Maven version',
      error: 'Unable to verify Maven version'
    });
  }
  catch (error) {
    customError(error.message);
    throw new Error(`Failed to parse project details. ${error.message}`);
  }
  finally {
    core.info('');
    core.endGroup();
  }

  // -----------------------------------------------
  core.startGroup(`Cloning project main code...`);

  try {
    args.main.clone = await checkExec('git', {
      param: ['clone', '--depth', '1', '-c', 'advice.detachedHead=false',
        '--no-tags', '--branch', args.project.version,
        `https://github-actions:${token}@github.com/${args.main.full}`, args.main.dir],
      title: `Cloning ${args.project.version} from ${args.main.full} into ${args.main.dir}`,
      error: `Cloning ${args.main.full} returned non-zero exit code`
    });

    await checkExec('ls', {
      param: ['-C', `${args.main.dir}/src/main/java`],
      title: 'Listing project main code',
      error: 'Unable to list directory'
    });
  }
  catch (error) {
    customError(error.message);
    throw new Error(`Failed to clone project main code. ${error.message}`);
  }
  finally {
    core.info('');
    core.endGroup();
  }

  // -----------------------------------------------
  core.startGroup(`Cloning project test code...`);

  try {
    const commits = await octokit.repos.listCommits({
      owner: args.test.user,
      repo: args.test.repo,
      per_page: 1
    });

    if ('data' in commits && commits.data.length > 0) {
      args.test.hash = commits.data[0].sha;
      args.test.key = `${args.test.dir}-${args.test.hash}`;

      core.info('\nAttempting to restore test cache...');
      args.test.cache = await cache.restoreCache(
        [args.test.dir],       // paths to restore
        args.test.key,         // current key
        [`${args.test.dir}-`]  // keys to restore
      );

      if (args.test.cache !== undefined) {
        core.info(`Restored cache: ${args.test.cache}`);
      }
      else {
        throw new Error(`Cache ${args.test.key} not found.`);
      }
    }
    else {
      throw new Error(`Unable to list ${args.test.full} commits.`);
    }
  }
  catch (error) {
    // this is okay, but should log it happened
    core.info(`Unable to restore ${args.test.dir} cache. ${error.message}`);
  }

  try {
    if ('cache' in args.test && args.test.cache !== undefined) {
      core.info(`Cache found: ${args.test.cache}`);
    }
    else {
      args.test.clone = await checkExec('git', {
        param: ['clone', '--depth', '1', '--no-tags', `https://github-actions:${token}@github.com/${args.test.full}`, args.test.dir],
        title: `Cloning ${args.test.full} into ${args.test.dir}`,
        error: `Cloning ${args.test.full} returned non-zero exit code`
      });
    }

    await checkExec('ls', {
      param: ['-C', `${args.test.dir}/src/test/java`],
      title: 'Listing project test code',
      error: 'Unable to list directory'
    });
  }
  catch (error) {
    customError(error.message);
    throw new Error(`Failed to clone project test code. ${error.message}`);
  }
  finally {
    core.info('');
    core.endGroup();
  }

  // -----------------------------------------------
  core.startGroup('Caching maven plugins...');

  try {
    args.maven = {};
    args.maven.hash = '';

    core.info('\nHashing pom.xml file...');
    const sha256 = await exec.exec('sha256sum', [`${args.main.dir}/pom.xml`], {
      ignoreReturnCode: true,
      listeners: {
        stdout: (data) => {
          args.maven.hash += data.toString();
        }
      }
    });

    if (sha256 !== 0) {
      throw new Error(`Unable to hash ${args.main.dir}/pom.xml file (${sha256}).`);
    }

    args.maven.hash = args.maven.hash.split(' ')[0];
    args.maven.key = `${args.os}-m2-${args.maven.hash}`;

    core.info('\nAttempting to restore Maven cache...');
    args.maven.cache = await cache.restoreCache(
      ['~/.m2'],          // paths to restore
      args.maven.key,     // current key
      [`${args.os}-m2-`]  // keys to restore
    );

    if (args.maven.cache !== undefined) {
      core.info(`Restored cache: ${args.maven.cache}`);
    }
    else {
      throw new Error(`Cache ${args.maven.key} not found.`);
    }
  }
  catch (error) {
    // this is okay, but should log it happened
    core.info(`Unable to restore Maven cache. ${error.message}`);
  }

  // TODO START HERE WITH MAIN

  try {
    args.maven.status = await checkExec('mvn', {
      param: ['-f', `${args.main.dir}/pom.xml`, '-ntp', 'dependency:go-offline'],
      title: 'Updating Maven dependencies',
      error: 'Updating returned non-zero exit code',
    });
  }
  catch (error) {
    customError(error.message);
    throw new Error(`Failed to update Maven cache. ${error.message}`);
  }
  finally {
    core.info('');
    core.endGroup();
  }

  // -----------------------------------------------
  core.startGroup('Compiling project main code...');

  try {
    args.main.compile = await checkExec('mvn', {
      param: ['-ntp', '-DcompileOptionXlint="-Xlint:none"', '-DcompileOptionXdoclint="-Xdoclint:none"', '-DcompileOptionFail="false"', '-Dmaven.compiler.showWarnings="true"', 'compile'],
      title: 'Compiling project main code',
      error: 'Compiling returned non-zero exit code',
      chdir: `${args.main.dir}/`
    });

    await checkExec('ls', {
      param: ['-C', `${args.main.dir}/target/classes`],
      title: 'Listing main class files',
      error: 'Unable to list directory',
    });
  }
  catch (error) {
    customError(error.message);
    throw new Error(`Failed to compile project main code. ${error.message}`);
  }
  finally {
    core.info('');
    core.endGroup();
  }

  // -----------------------------------------------
  core.startGroup('Compiling project test code...');

  try {
    args.test.compile = await checkExec('mvn', {
      param: ['-ntp', '-DcompileOptionXlint="-Xlint:none"', '-DcompileOptionXdoclint="-Xdoclint:none"', '-DcompileOptionFail="false"', '-Dmaven.compiler.showWarnings="true"', 'test-compile'],
      title: 'Compiling project test code',
      error: 'Compiling returned non-zero exit code',
      chdir: `${args.main.dir}/`
    });

    await checkExec('ls', {
      param: ['-C', `${args.main.dir}/target/test-classes`],
      title: 'Listing main class files',
      error: 'Unable to list directory',
    });
  }
  catch (error) {
    customError(error.message);
    throw new Error(`Failed to compile project test code. ${error.message}`);
  }
  finally {
    core.info('');
    core.endGroup();
  }

/*
= await checkExec(, {
  param: ,
  title: ,
  error: ,
  chdir: `${args.main.dir}/`
});
*/
}

async function debug(context, octokit, args) {

}

async function verify(context, octokit, args) {
  core.startGroup('Running verification tests...');
  // -----------------------------------------------

  try {
    args.results.verify = await checkExec('mvn', {
      param: ['-ntp', `-Dtest=${args.project.tester}`, '-DexcludedGroups=none()|!verify', 'test'],
      title: 'Running verification tests',
      error: false,
      chdir: `${args.main.dir}/`
    });

    arg.results.message = args.results.verify === 0 ? `All Project ${args.project.number} verification tests of ${args.project.version} passed.` : `One or more Project ${args.project.number} verification tests of ${args.project.version} failed.`;

    // TODO Here
    /*
    Figure out cleanup when verification fails.
    */

    if (args.results.verify === 0) {
      const message = `All Project ${args.project.number} verification tests of ${args.project.version} passed.`

      core.info(message);
      addAnnotation('Verification Passed', message, 'notice', 'success');
    }
    else {

    }

    if (args.project.type === 'tags') {

    }
  }
  catch (error) {
    customError(error.message);
    await debug(context, octokit, args);
    throw new Error(`Failed verification tests. ${error.message}`);
  }
  finally {
    core.info('');
    core.endGroup();
  }



  //
  // https://github.com/actions/toolkit/blob/d9347d4ab99fd507c0b9104b2cf79fb44fcc827d/packages/exec/src/interfaces.ts#L21-L22
  //   // including quotation marks causes this part to fail?
  //
  //   core.info('');
  //   args.results = {};
  //   args.results.verify = await exec.exec('mvn', ['-ntp', `-Dtest=${args.project.tester}`, '-DexcludedGroups=none()|!verify', 'test'], cwd);
  //
  //   let message = '';
  //
  //   if (args.results.verify === 0) {
  //     message = `All Project ${args.project.number} verification tests of ${args.project.version} passed.`
  //
  //     core.info(message);
  //     addAnnotation('Verification Passed', message, 'notice', 'success');
  //   }
  //   else {
  //     message = `One or more Project ${args.project.number} verification tests of ${args.project.version} failed.`;
  //
  //     core.error(message);
  //   }



}

async function cleanup(context, octokit, args) {
  core.startGroup('Cleaning up...');
  let okay = true;

  try {
    if ('results' in args && 'message' in args.results && args.project.type === 'tags') {
      core.info('\nUpdating ${args.project.version} release...');
      const release = await octokit.repos.getReleaseByTag({
        owner: context.payload.organization.login,
        repo: context.payload.repository.name,
        tag: args.project.version
      });

      await octokit.repos.updateRelease({
        owner: context.payload.organization.login,
        repo: context.payload.repository.name,
        release_id: release.data.id,
        body: `${args.results.message} See action run #${context.runNumber} (${context.runId}).`
      });
    }
  }
  catch (error) {
    okay = false;
    core.info(`Unable to update the ${args.project.version} release.`);
  }

  try {
    core.info('');
    core.info(`Saving ${args.test.key} to cache...`);

    const result = await cache.saveCache([args.test.dir], args.test.key);
    core.info(`Saved cache: ${result}`);
  }
  catch (error) {
    okay = false;
    core.info(`Unable to save tests cache. ${error.message}`);
  }

  try {
    core.info('');
    core.info(`Saving ${args.maven.key} to cache...`);

    const result = await cache.saveCache(['~/.m2'], args.maven.key);
    core.info(`Saved cache: ${result}`);
  }
  catch (error) {
    okay = false;
    core.info(`Unable to save maven cache. ${error.message}`);
  }

  if (okay !== true) {
    core.warning('One or more cleanup steps failed.');
  }

  core.info('');
  core.endGroup();
}

async function run() {
  const args = {};
  const context = github.context;

  const token = core.getInput('token');
  core.setSecret(token);

  const octokit = github.getOctokit(token);

  try {
    // customHeading('SETUP PHASE');
    // await setup(context, octokit, args, token);
    //
    // customHeading('VERIFICATION PHASE');
    // await verify(context, octokit, args);
  }
  catch (error) {
    // TODO: Customize annotation
    core.setFailed(`Unable to verify project. ${error.message}`);
  }
  finally {
    // customHeading('CLEANUP PHASE');
    // await cleanup(context, octokit, args);
    //
    // core.startGroup(`Saving run #${context.runNumber} (${context.runId}) status...`);
    // core.info('');
    // core.info(JSON.stringify(args));
    // core.endGroup();
  }
}

  // // +------------------------------------------------+
  // // | VERIFICATION PHASE                             |
  // // +------------------------------------------------+
  //
  // try {
  //   // run verification tests
  //   // -----------------------------------------------
  //
  //   core.startGroup('Running verification tests...');
  //
  // https://github.com/actions/toolkit/blob/d9347d4ab99fd507c0b9104b2cf79fb44fcc827d/packages/exec/src/interfaces.ts#L21-L22
  //   // including quotation marks causes this part to fail?
  //
  //   core.info('');
  //   args.results = {};
  //   args.results.verify = await exec.exec('mvn', ['-ntp', `-Dtest=${args.project.tester}`, '-DexcludedGroups=none()|!verify', 'test'], cwd);
  //
  //   let message = '';
  //
  //   if (args.results.verify === 0) {
  //     message = `All Project ${args.project.number} verification tests of ${args.project.version} passed.`
  //
  //     core.info(message);
  //     addAnnotation('Verification Passed', message, 'notice', 'success');
  //   }
  //   else {
  //     message = `One or more Project ${args.project.number} verification tests of ${args.project.version} failed.`;
  //
  //     core.error(message);
  //   }
  //
  //   // TODO Fix
  //   args.project.update = true;
  //
  //   // update release description if appropriate
  //   if (args.project.update) {
  //     try {
  //       const release = await octokit.repos.getReleaseByTag({
  //         owner: context.payload.organization.login,
  //         repo: context.payload.repository.name,
  //         tag: args.project.version
  //       });
  //
  //       await octokit.repos.updateRelease({
  //         owner: context.payload.organization.login,
  //         repo: context.payload.repository.name,
  //         release_id: release.data.id,
  //         body: message
  //       });
  //     }
  //     catch (error) {
  //       core.warning(`Unable to update the ${args.project.version} release.`);
  //     }
  //   }
  //
  //   core.info('');
  //   core.endGroup();
  //
  //   if (args.results.verify === 0) {
  //     // skip everything else
  //     // return; TODO Fix
  //     core.info('Skipping debug tests and report generation...');
  //   }
  //   else {
  //
  //   }
  // }
  // catch (error) {
  //   core.setFailed(`Project verification failed: ${error.message}`);
  // }
  //
  // // +------------------------------------------------+
  // // | DEBUG PHASE                                    |
  // // +------------------------------------------------+
  //
  // try {
  //   // if necessary run debug tests
  //   // -----------------------------------------------
  //
  //   if (!!args.results)
  //
  //   core.info('Enabling output for debugging...');
  //
  //   core.startGroup('Running all tests for debugging...');
  //
  //   core.info('');
  //   args.results.debug = await exec.exec('mvn', ['-ntp', `-Dtest=${args.project.tester}`, '-DexcludedGroups=verify', 'test'], cwd);
  //
  //   core.info('');
  //   core.endGroup();
  //
  //   // generate test reports
  //   // -----------------------------------------------
  //
  //   core.startGroup('Generating reports...');
  //
  //   core.info('');
  //   args.reports = {};
  //   args.reports.make = await exec.exec('mvn', ['-ntp', 'surefire-report:report-only'], cwd);
  //
  //   // generate css
  //   core.info('');
  //   args.reports.site = await exec.exec('mvn', ['-ntp', 'site', '-DgenerateReports=false'], cwd);
  //
  //
  //   if (args.reports.make + args.reports.site != 0) {
  //     core.warning('One or more steps generating reports failed.');
  //   }
  //
  //   core.info('');
  //   await exec.exec('ls', [`${args.main.dir}/target/site`]);
  //
  //   core.info('');
  //   core.endGroup();
  //
  //   // attach reports to action
  //   // -----------------------------------------------
  //
  //   core.startGroup('Uploading reports...');
  //
  //   // zip up actual files
  //   core.info('');
  //   // args.reports.actual = await exec.exec('zip', ['-r', 'target/site/actual.zip', 'actual'], cwd);
  //
  //   core.info('');
  //   core.endGroup();
  // }
  // catch (error) {
  //   core.setFailed(`Project verification failed: ${error.message}`);
  // }

run();
