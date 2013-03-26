#! /usr/bin/env node

var
  fs = require('fs'),
  https = require('https'),
  ini = require('ini'),
  config = ini.parse(fs.readFileSync(process.env.HOME + '/.raxrc', 'utf-8'));


config.credentials && config.credentials.username && config.credentials.api_key || error('Need credentials in ~/.raxrc!');

auth(config.credentials.username, config.credentials.api_key, function(err, auth_token) {
  console.log(auth_token);
});


function auth(username, api_key, callback) {
  var
    creds = auth_credentials(username, api_key),
    options = {
      hostname: 'auth.api.rackspacecloud.com',
      path: 'v2.0/tokens',
      method: 'POST',
      headers: {
        'User-Agent': 'maas-in-chains 0.0.0',
        'Accept-Encoding': 'gzip,deflate',
        'Content-Type': 'application/json; charset=UTF-8',
        'Content-Length': Buffer.byteLength(creds, 'utf8'),
        'Accept': 'application/json'
      }
    },
    req = https.request(options, function(res) {
      var response = '';
      console.dir(res.headers);
      res.setEncoding('utf8');
      res.on('data', function(chunk) {
        console.log(chunk);
        response += chunk;
      });
      res.on('end', function() {
        callback(null, JSON.parse(response));
      });
    });

  req.on('error', function(e) {
    error(e.message);
  });

  console.dir(req);
  console.log(creds);
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
