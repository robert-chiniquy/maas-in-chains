#! /usr/bin/env node

var
  fs = require('fs'),
  https = require('https'),
  async = require('async'),
  sh = require('shelljs'),
  ini = require('ini'),
  config = ini.parse(fs.readFileSync(process.env.HOME + '/.raxrc', 'utf-8'));

(config.credentials
  && config.credentials.username
  && config.credentials.api_key
  && config.credentials.tenant_id) || error('Need credentials in ~/.raxrc!');

if (fs.exists(repo_root() + 'manifest.ini')) {
  var manifest = ini.parse(fs.readFileSync(repo_root() + 'manifest.ini', 'utf-8'));
  if (manifest && manifest.credentials.username !== config.credentials.username) {
    error("The manifest username doesn't match your .raxrc!");
  }
  sync_maas_repo(function(err, result) {
    if (err) {
      error(err);
    }
    console.dir(result);
  });
} else {
  init_maas_repo(function(err, result) {
    if (err) {
      error(err);
    }
    console.dir(result);
  });
}

function sync_maas_repo(callback) {
  async.auto({
    'auth_token': auth.bind(null, config.credentials.username, config.credentials.api_key),
    'overview': ['auth_token', function getOverview(callback, result) {
      overview(config.credentials.tenant_id, result.auth_token, callback);
    }]
  }, function(err, result) {
    var stashed = false;
    if (err) {
      callback(err);
    }

    process.chdir(repo_root());

    if (local_changes()) {
      sh.exec('git stash');
      stashed = true;
    }

    // TODO: this method will not detect items that have been deleted via the API
    // need to detect deletes and git rm them
    write_overview_to_local(result.overview);

    if (!stashed) {
      // no local changes to apply
      callback();
      return;
    }

    if (sh.exec('git stash pop').code !== 0) {
      sh.exec('git stash');
      callback('git stash pop failed! Possible merge conflict? Re-stashed your changes.');
      return;
    }

    write_changes_to_api(result.auth_token, sh.exec('git diff --name-only').split('\n'), function(err, result) {
      if (err) {
        callback(err);
        return;
      }
      sh.exec('git commit -m "Adding changes from API"');
      callback(null);
    });
  });
}

function init_maas_repo(callback) {
  async.auto({
    'auth_token': auth.bind(null, config.credentials.username, config.credentials.api_key),
    'overview': ['auth_token', function getOverview(callback, result) {
      overview(config.credentials.tenant_id, result.auth_token, callback);
    }],
    'init': ['overview', function initRepo(callback, result) {
      write_repo_dir(result.overview, callback);
    }]
  }, callback);
}

// return true if the maas_repo has been changed locally
function local_changes() {
  process.chdir(repo_root());
  if (sh.exec('git diff | grep -q .').code !== 0) {
    return true;
  }
  return false;
}

function path_to_url(path) {
  var
    parts = path.split('/');

  if (parts.length === 2) {
    // entity
    return '/v1.0/entities/' + parts[0];
  } else if (parts.length === 3) {
    if (parts[2].match(/^ch/)) {
      // check
      return '/v1.0/entities/' + parts[0] + '/checks/' + parts[1];
    } else {
      // alarm
      var alarm_id = parts[2].replace('.json','');
      return '/v1.0/entities/' + parts[0] + '/alarms/' + alarm_id;
    }
  }
}

function post_file(auth_token, filename, url) {
  var
    body = fs.readFileSync(filename);
    options = {
      hostname: 'monitoring.api.rackspacecloud.com',
      path: url,
      method: 'POST',
      headers: {
        'User-Agent': 'maas-in-chains 0.0.0',
        'Content-Length': Buffer.byteLength(body, 'utf8'),
        'Accept': 'application/json',
        'X-Auth-Token': auth_token
      }
    },
    req = https.request(options, function(res) {
      var response = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk) {
        response += chunk;
      });
      res.on('end', function() {
        callback();
      });
    });

  req.on('error', function(e) {
    error(e.message);
  });
  req.write(body);
  req.end();
}

function write_changes_to_api(auth_token, filenames, callback) {
  // for each changed {entity, check, alarm}
  //    construct the URL to POST to
  //    POST the file to the URL
  async.forEachLimit(filenames, 4, function updateItem(filename, callback) {
    post_file(auth_token, filename, url, callback);
  }, callback);
}

function repo_root() {
  return __dirname +'/../maas-repo/';
}

function entityDir(entity_id) {
  return repo_root() + entity_id;
}

function entityJson(entity_id) {
  return entityDir(entity_id) + '/' + entity_id + '.json';
}

function checkDir(entity_id, check_id) {
  return entityDir(entity_id) + '/' + check_id;
}

function checkJson(entity_id, check_id) {
  return checkDir(entity_id, check_id) + '/' + check_id + 'json';
}

function alarmJson(entity_id, check_id, alarm_id) {
  return checkDir(entity_id, check_id) + '/' + alarm_id + 'json';
}

function write_overview_to_local(overview) {
  overview.values.forEach(function(entry) {
    var
      entity = entry.entity,
      checks = entry.checks,
      alarms = entry.alarms;

    // for each entity, create a directory, then write to a file enNAME.json
    if (!fs.existsSync(entityDir(entity.id))) {
      fs.mkdirSync(entityDir(entity.id));
    }
    if (!fs.existsSync(entityJson(entity.id))) {
      fs.writeFileSync(entityJson(entity.id), JSON.stringify(entity, null, 2));
      sh.exec('git add ' + entityJson(entity.id));
    }

    // then for each check for each entity, create a directory, then write to a file chNAME.json
    checks.forEach(function(check) {
      if (!fs.existsSync(checkDir(entity.id, check.id))) {
        fs.mkdirSync(checkDir(entity.id, check.id));
      }
      if (!fs.existsSync(checkJson(entity.id, check.id))) {
        fs.writeFileSync(checkJson(entity.id, check.id), JSON.stringify(check, null, 2));
        sh.exec('git add '+ checkJson(entity.id, check.id));
      }
    });

    // then for each alarm, write to a file alNAME.json in the check dir
    alarms.forEach(function(alarm) {
      fs.writeFileSync(alarmJson(entity.id, alarm.check_id, alarm.id), JSON.stringify(alarm, null, 2));
      sh.exec('git add ' + alarmJson(entity.id, alarm.check_id, alarm.id));
    });
  });
}

function write_repo_dir(overview, callback) {
  var res;

  if (!fs.existsSync(repo_root())) {
    fs.mkdirSync(repo_root());
  }
  process.chdir(repo_root());

  // validate that it is not already a git repo
  if (fs.existsSync(repo_root() + '.git')) {
    error('write() called but this is already a git directory!');
  }

  if (res = sh.exec('git init').code !== 0) {
    error(res.output);
  }

  // write a little ini representing the current account
  var manifest = {};
  manifest.credentials = {};
  manifest.credentials.username = config.credentials.username
  fs.writeFileSync(repo_root() + 'manifest.ini', ini.stringify(manifest));
  sh.exec('git add manifest.ini');

  write_overview_to_local(overview);

  sh.exec('git commit -m "Initial commit"');
}

function overview(tenant_id, auth_token, callback) {
  var
    options = {
      hostname: 'monitoring.api.rackspacecloud.com',
      path: '/v1.0/' + tenant_id + '/views/overview',
      method: 'GET',
      headers: {
        'User-Agent': 'maas-in-chains 0.0.0',
        'Content-Length': 0,
        'Accept': 'application/json',
        'X-Auth-Token': auth_token
      }
    },
    req = https.request(options, function(res) {
      var response = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk) {
        response += chunk;
      });
      res.on('end', function() {
        callback(null, JSON.parse(response));
      });
    });

  req.on('error', function(e) {
    error(e.message);
  });
  req.end();
}

function auth(username, api_key, callback) {
  var
    creds = auth_credentials(username, api_key),
    options = {
      hostname: 'auth.api.rackspacecloud.com',
      path: '/v2.0/tokens',
      method: 'POST',
      headers: {
        'User-Agent': 'maas-in-chains 0.0.0',
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(creds, 'utf8'),
        'Accept': 'application/json'
      }
    },
    req = https.request(options, function(res) {
      var response = '';
      res.setEncoding('utf8');
      res.on('data', function(chunk) {
        response += chunk;
      });
      res.on('end', function() {
        var auth_token;
        response = JSON.parse(response);
        if (!(response.access && response.access.token && response.access.token.id)) {
          callback("Bad response from Keystone!", response);
          return;
        }
        auth_token = response.access.token.id;
        callback(null, auth_token);
      });
    });

  req.on('error', function(e) {
    error(e.message);
  });

  req.end(creds);
}

function auth_credentials(username, api_key) {
  return JSON.stringify({
    "auth": {
      "RAX-KSKEY:apiKeyCredentials": {
        "username": username,
        "apiKey": api_key
      }
    }
  });
}

function error(message) {
  process.stderr.write(message + '\n');
  process.exit(1);
}
