var express    = require('express');
var http       = require('http');
var bodyParser = require("body-parser");
//var Promise    = require('es6-promise').Promise;
var request    = require("request");
var GoogleAuth = require('google-auth-library');
var oauth2 = new (new GoogleAuth).OAuth2();
var Session = require('express-session');
require('dotenv').load();

// Save the subscriptions since heroku kills free dynos like the ice age.
var mongodb = require('mongodb');

var activeSubscriptions = new Map();
var previousRequestTime = 0;
var users = {}; // should be cleaned up over time. will just fill up at the moment
var sessionStore = new Session.MemoryStore();
var contentData = {};

/**
 * Setup
 */

// S-s-s-server.
var app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(Session({
  secret: 'keyboard cat',
  cookie: { maxAge: 60000000, secure: false },
  resave: false,
  store: sessionStore,
  saveUninitialized: true
}));
app.use(express.static(__dirname + '/public'));
app.use('/bower_components',  express.static(__dirname + '/bower_components'));
app.set('port', process.env.PORT || 3000);

var server = http.createServer(app).listen(app.get('port'), function() {
  console.log('Started server on port ' + app.get('port'));
});

// Restore subscriptions.
var databasePromise = new Promise(function(resolve, reject) {
  mongodb.MongoClient.connect(process.env.MONGOLAB_URI, function(err, db) {
    if (err) {
      return reject(err);
    }
    resolve(db);
  });
});

databasePromise.then(function(db) {
  db.collection('subscriptions').find({}).toArray(function(err, result) {
    console.log(result);
    result.forEach(function(elem){
      activeSubscriptions.set(elem.id, elem.user);
    });
    console.log("Subscriptions loaded from database: " +activeSubscriptions.size);
  });
}).catch(function(err) {
  console.log('DATABASE ERROR:', err, err.stack);
});


app.post('/get_content', function (req, res) {
  var idtoken = req.body.idtoken;
  oauth2.verifyIdToken(idtoken, null, function(error, ticket){
        var sub = ticket.getPayload().sub;
    console.log(contentData[sub]);
    console.log(sub);
    res.json({'content': contentData[sub]});

  });


});

/**
 * I don't know how to load heroku config values into a json file.
 */
var manifest = require('./manifest.json');
manifest.gcm_sender_id = process.env.GCM_SENDER;

app.get('/manifest.json', function (req, res) {
  res.json(manifest);
});

/**
 * Add or remove a subscription.
 */
app.post('/subscription_change', function (req, res) {
  var enabled = req.body.enabled;
  var id = req.body.id;
  var subscription = activeSubscriptions.get(id);
  var idtoken = req.body.idtoken;

  oauth2.verifyIdToken(idtoken, null, function(error, ticket){
    if (enabled == 'true') {
      if (!subscription) {
        var sub = ticket.getPayload().sub;
        databasePromise.then(function(db) {
          db.collection('subscriptions').insertOne({id: id, user: sub});
        });
        activeSubscriptions.set(id,  sub);
        users[req.sessionID] =  sub;
      } else {
        users[req.sessionID] =  subscription;
      }
    } else {
      activeSubscriptions.delete(id);
      databasePromise.then(function(db) {
        db.collection('subscriptions').deleteOne({id: id});
      });
    }
  });

  res.end();
});

/**
 * Returns the number of known subscriptions (some could be inactive).
 */
app.get('/get_subscription_count', function (req, res) {
  res.json({'subscriptions': activeSubscriptions.size});
});

/**
 * Send ヽ(^‥^=ゞ) to everyone!! But only once a minute because lol spam.
 */
app.post('/push_content', function (req, res) {
  var user = users[req.session.id];

  console.log(req.body.content);
  contentData[user] = req.body.content;
  var elapsed = new Date() - previousRequestTime;
  if ((elapsed / 1000) < 5) {
    console.log("throttled");
    res.end('Request throttled. No cat spam!');
    return;
  }
  res.end();

  var reg_ids = [];
  console.log(activeSubscriptions);
  console.log(user);
  activeSubscriptions.forEach(function(u, id){
    if (user == u) {
      reg_ids.push(id);
    }
  });

  console.log(reg_ids);
  var data = {
    "delayWhileIdle":true,
    "timeToLive":3,
    "data":{
      'title': req.body.content,
      'message': 'test'
    },
    "registration_ids": reg_ids
  };

  var dataString =  JSON.stringify(data);
  var headers = {
    'Authorization' : 'key=' + process.env.API_KEY,
    'Content-Type' : 'application/json'
  };

  var options = {
    host: 'android.googleapis.com',
    port: 80,
    path: '/gcm/send',
    method: 'POST',
    headers: headers
  };

  var req2 = http.request(options, function(res) {
    res.setEncoding('utf-8');
    var responseString = '';

    res.on('data', function(data) {
      responseString += data;
    });
    res.on('end', function() {
      console.log(responseString);
    });
    console.log('STATUS: ' + res.statusCode);
  });
  req2.on('error', function(e) {
    console.log('error : ' + e.message + e.code);
  });

  req2.write(dataString);
  req2.end();
  previousRequestTime = new Date();
});

/**
 * Try to close the database.  ¯\_(ツ)_/¯
 */
var gracefulShutdown = function() {
  console.log("Received kill signal, shutting down gracefully.");
  databasePromise.then(function(db) {
    console.log("closing db");
    db.close();
  }).then(function() {
    server.close(function() {
      console.log("Closed out remaining connections.");
      process.exit()
    });
  });
};

// listen for TERM signal .e.g. kill
process.on ('SIGTERM', gracefulShutdown);
// listen for INT signal e.g. Ctrl-C
process.on ('SIGINT', gracefulShutdown);
