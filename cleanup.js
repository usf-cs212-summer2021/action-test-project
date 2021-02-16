const core = require('@actions/core');
const github = require('@actions/github');
const exec = require('@actions/exec');
const cache = require('@actions/cache');
const artifact = require('@actions/artifact');
const glob = require('@actions/glob');
const utils = require('./utils.js');

async function run() {
  const status = {}; // status of intermediate steps
  const states = {}; // things to remember between pre/main/post

  const token = core.getInput('token');
  core.setSecret(token);

  const octokit = github.getOctokit(token);

  utils.restoreStates(states);

  utils.showTitle('Cleanup Reporting Phase');

  if ('passed' in states && states.passed !== 'true') {
    const artifactClient = artifact.create();

    try {
      // -----------------------------------------------
      core.startGroup('Generating test reports...');

      status.reports = await utils.checkExec('mvn', {
        param: ['-ntp', 'surefire-report:report-only'],
        title: 'Generating reports',
        error: 'Unable to generate reports',
        chdir: `${utils.mainDir}/`
      });

      core.info('Generated surfire reports.');

      status.site = await utils.checkExec('mvn', {
        param: ['-ntp', '-DgenerateReports=false', 'site'],
        title: 'Generating report site',
        error: 'Unable to generate report site',
        chdir: `${utils.mainDir}/`
      });

      core.info('Generated report site.');

      await utils.checkExec('ls', {
        param: ['-m', `${utils.mainDir}/target/site`],
        title: 'Listing project report site',
        error: 'Unable to list site directory'
      });

      core.info('');
      core.endGroup();
      // -----------------------------------------------

      // -----------------------------------------------
      core.startGroup('Uploading report files...');

      status.siteZip = await utils.checkExec('zip', {
        param: ['-r', '../../results.zip', `site`],
        title: 'Zipping test report site',
        error: 'Unable to zip test report site',
        chdir: `${utils.mainDir}/target/`
      });

      await utils.checkExec('ls', {
        param: ['-l', `.`],
        title: 'Listing working directory',
        error: 'Unable to list working directory'
      });

      core.info('\nUploading artifacts...');
      status.sizeUpload = await artifactClient.uploadArtifact(
        'Test Reports', ['results.zip'], '.'
      );

      if (status.sizeUpload.failedItems.length != 0) {
        const items = status.sizeUpload.failedItems.join(', ');
        throw new Error(`Failed to upload: ${items}.`);
      }

      core.info('');
      core.endGroup();
      // -----------------------------------------------
    }
    catch (error) {
      core.endGroup();
      utils.showWarning(`Encountered issues generating reports. ${error.message}`);
    }

    try {
      // -----------------------------------------------
      core.startGroup('Uploading actual files...');

      const globber = await glob.create(`${utils.testDir}/actual/*`);
      const found = await globber.glob();

      if (found.length > 0) {
        core.info(`Found: ${found}`);

        status.actualZip = await utils.checkExec('zip', {
          param: ['-r', '../actual.zip', 'actual'],
          title: 'Zipping actual output files',
          error: 'Unable to zip actual output files',
          chdir: `${utils.testDir}/`
        });

        await utils.checkExec('ls', {
          param: ['-l', `.`],
          title: 'Listing working directory',
          error: 'Unable to list working directory'
        });

        // prevent actual files from entering cache
        await utils.checkExec('rm', {
          param: ['-rf', `${utils.testDir}/actual`],
          title: 'Removing actual files...',
          error: 'Unable to remove actual files'
        });

        core.info('\nUploading artifacts...');
        status.actualUpload = await artifactClient.uploadArtifact(
          'Actual Output', ['actual.zip'], '.'
        );

        core.info(`Uploaded ${status.actualUpload.size} bytes.`);

        if (status.actualUpload.failedItems.length != 0) {
          const items = status.actualUpload.failedItems.join(', ');
          throw new Error(`Failed to upload: ${items}.`);
        }
      }
      else {
        core.info('Skipping; no actual output files to upload.');
      }

      core.info('');
      core.endGroup();
      // -----------------------------------------------
    }
    catch (error) {
      core.endGroup();
      utils.showWarning(`Encountered issues uploading actual files. ${error.message}`);
    }
  }
  else {
    core.info('Skipping; no debug output to generate.');
  }

  utils.showTitle('Cleanup Annotation Phase');

  try {
    // -----------------------------------------------
    core.startGroup('Updating release...');

    const ref = github.context.ref;

    if ('passed' in states && 'message' in states && ref.startsWith('refs/tags/v')) {
      const release = await octokit.repos.getReleaseByTag({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        tag: states.version
      });

      status.release = release.status;

      if (release.status === 200) {
        core.info(`Found release ${release.data.tag_name}.`);

        const update = await octokit.repos.updateRelease({
          owner: github.context.repo.owner,
          repo: github.context.repo.repo,
          release_id: release.data.id,
          body: `:octocat: ${states.message} See action run #${github.context.runNumber} (${github.context.runId}).`
        });

        status.release = update.status

        if (update.status === 200) {
          core.info(`Updated release ${update.data.tag_name} description.`)
        }
        else {
          core.debug(JSON.stringify(update));
          throw new Error(`Unable to update release: ${states.version}`);
        }
      }
      else {
        core.debug(JSON.stringify(release));
        throw new Error(`Unable to find release: ${states.version}`);
      }
    }
    else {
      core.info(`Skipping; ref ${ref} is not a valid release or tag.`);
    }

    core.info('');
    core.endGroup();
    // -----------------------------------------------
  }
  catch (error) {
    core.endGroup();
    utils.showWarning(`Encountered issues updating release. ${error.message}`);
  }

  try {
    // -----------------------------------------------
    core.startGroup('Adding status annotation...');

    const annotation = {
      path: `.github`,
      start_line: 1,
      end_line: 1,
      title: 'Verification Status'
    };

    const settings = {
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      head_sha: github.context.sha
    };

    let emoji = ':x:'; // failure by default

    if ('passed' in states && states.passed === 'true') {
      // verification was successful
      emoji = ':white_check_mark:';
      settings.name = 'Verification Passed';
      settings.conclusion = 'success';

      annotation.message = states.message;
      annotation.annotation_level = 'warning'; // notice does not show up in summary
    }
    else if ('message' in states) {
      // verification ran but failed
      settings.name = 'Verification Failed';
      settings.conclusion = 'failure';

      annotation.message = states.message;
      annotation.annotation_level = 'notice'; // used on purpose; failures already in summary
    }
    else {
      // didn't get to verification step
      settings.name = 'Verification Incomplete';
      settings.conclusion = 'failure';

      annotation.message = `One or more Project ${states.project} verification steps of ${states.version} failed.`;
      annotation.annotation_level = 'notice'; // used on purpose; failures already in summary
    }

    settings.output = {
      title: settings.name,
      summary: `${emoji}&nbsp; ${annotation.message}`,
      annotations: [annotation]
    };

    core.info(JSON.stringify(settings));

    const result = await await octokit.checks.create(settings);
    status.annotate = result.status;

    if (status.annotate === 201) {
      core.info(`Annotation added at: ${result.data.output.annotations_url}`);
    }
    else {
      core.debug(JSON.stringify(result));
      throw new Error(`Annotation failed with status ${status.annotate}.`);
    }

    core.info('');
    core.endGroup();
    // -----------------------------------------------
  }
  catch (error) {
    core.endGroup();
    utils.showWarning(`Encountered issues adding annotation. ${error.message}`);
  }

  utils.showTitle('Cleanup Cache Phase');

  try {
    // -----------------------------------------------
    core.startGroup(`Saving ${utils.testDir} cache...`);

    if ('testKey' in states) {
      if ('testCache' in states && states.testKey === states.testCache) {
        core.info(`Skipping; cache already exists.`);
      }
      else {
        core.info(`Saving ${states.testKey} to cache...`);
        status.testCache = await cache.saveCache([utils.testDir], states.testKey);
        core.info(`Saved cache: ${status.testCache}`);
      }
    }
    else {
      core.info('Unable to cache; key not found');
    }

    core.info('');
    core.endGroup();
    // -----------------------------------------------
  }
  catch (error) {
    core.endGroup();
    utils.showWarning(`Encountered issues saving cache. ${error.message}`);
  }

  try {
    // -----------------------------------------------
    core.startGroup('Saving Maven cache...');

    if ('mavenKey' in states) {
      if ('mavenCache' in states && states.mavenKey === states.mavenCache) {
        core.info(`Skipping; cache already exists.`);
      }
      else {
        core.info(`Saving ${states.mavenKey} to cache...`);
        status.mavenCache = await cache.saveCache(['~/.m2'], states.mavenKey);
        core.info(`Saved cache: ${status.mavenCache}`);
      }
    }
    else {
      core.info('Unable to cache; key not found');
    }

    core.info('');
    core.endGroup();
    // -----------------------------------------------
  }
  catch (error) {
    core.endGroup();
    utils.showWarning(`Encountered issues saving cache. ${error.message}`);
  }

  utils.showTitle('Cleanup Logging Phase');

  core.startGroup('Logging cleanup status...');
  core.info(`status: ${JSON.stringify(status)}`);
  core.info(`states: ${JSON.stringify(states)}`);
  core.endGroup();

  utils.checkWarnings('"Post Test Project"');
}

run();
