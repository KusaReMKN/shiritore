'use strict';

const ejs = require('ejs');
const fs = require('fs');
const http = require('http');
const sqlite3 = require('sqlite3');

/** The port number to listen on */
const PORT = 8080;

/** The HTML template */
const HTML_TEMPLATE = fs.readFileSync('./index.ejs', 'utf-8');

/** The session validity period (one year) */
const PERIOD = 1000 * 60 * 60 * 24 * 365;

/** Shiritore words database */
const db = new sqlite3.Database('./shiritore.db');
// XXX: How to close this database?

/**
 * Generate a UUIDv4.  The alphabet used is upper case.
 * XXX: The quality if the random number generator used by this implementation is not guaranteed.
 * Therefore, the generated UUIDs may not be sufficiently random.
 *
 * @returns { string } - generated UUIDv4
 */
function
generateUUID()
{
    /** Generate a random integer in the range [0, 256) */
    const randomByte = _ => Math.random() * 256 | 0;

    /** x in n-digit hexadecimal notation */
    const leadZero = (x, n) => ('0'.repeat(n) + (+x).toString(16)).slice(-n);

    const buf = [];
    for (let i = 0; i < 4; i++)
        buf.push(leadZero(randomByte(), 2));
    buf.push('-');
    buf.push(leadZero(randomByte(), 2));
    buf.push(leadZero(randomByte(), 2));
    buf.push('-');
    buf.push(leadZero(randomByte() & 0x0F | 0x40, 2));
    buf.push(leadZero(randomByte(), 2));
    buf.push('-');
    buf.push(leadZero(randomByte() & 0x3F | 0x80, 2));
    buf.push(leadZero(randomByte(), 2));
    buf.push('-');
    for (let i = 0; i < 6; i++)
        buf.push(leadZero(randomByte(), 2));

    return buf.join('').toUpperCase();
}

/**
 * Write a simple error page and finish the response message.
 * Use as in: errorEnd(404, 'Hmm...')(req, res);
 *
 * @param { number } statusCode - HTTP status code
 * @param { string } [moreInfo] - extra message
 * @returns { (req: http.IncomingMessage, res: http.ServerResponse) => void }
 *      - function that does the actual work
 */
function
errorEnd(statusCode, moreInfo)
{
    return function (req, res) {
        res.writeHead(statusCode, http.STATUS_CODES[statusCode] || '');
        res.write(`${statusCode} ${http.STATUS_CODES[statusCode] || ''}\r\n`);
        moreInfo && res.write(moreInfo + '\r\n');
        res.end();
    };
}

/**
 * Process a GET request.
 *
 * @param { http.IncomingMessage } req - request message from the client
 * @param { http.ServerResponse } res - response message to the client
 * @returns { Promise<void> }
 */
async function
getShiritore(req, res)
{
    try {
        /* Retrieve a list of words from the database */
        const rows = await new Promise((res, rej) =>
            db.all('SELECT word FROM shiritore ORDER BY postAt;', (err, rows) =>
                err ? rej(err) : res(rows)));

        /* Send a response message by applying them to the template */
        res.end(ejs.render(HTML_TEMPLATE, { words: rows.map(e => e['word']) }));
    } catch (err) {
        errorEnd(500, err)(req, res);
    }
}

/**
 * Process a POST request.
 *
 * @param { http.IncomingMessage } req - request message from the client
 * @param { http.ServerResponse } res - response message to the client
 * @param { string } shirid - author identifier
 * @returns { Promise<void> }
 */
async function
postShiritore(req, res, shirid)
{
    /* Is the payload of an acceptable Content-Type? */
    if (req.headers['content-type'] !== 'application/x-www-form-urlencoded') {
        errorEnd(415)(req, res);
        return ;
    }

    /*
     * Parse the payload.
     * The payload has the keys and values are encoded in key-value tuples separated by '&',
     * with a '=' between the key and the value.  Non-alphanumeric characters in both keys and
     * values are URL encoded.
     */
    const decodeQueryParam = s => decodeURIComponent(s.replace(/\+/g, ' '));
    const payload = await new Promise(res => {
        const bufs = [];
        req.on('data', data => bufs.push(data));
        req.on('end', _ => res(Buffer.concat(bufs).toString()));
    });
    const paramList = payload.split('&');
    const paramDict = paramList.reduce((paramDict, elem) => {
        const [ key, value ] = elem.split('=').map(e => decodeQueryParam(e));
        paramDict[key] = value;
        return paramDict;
    }, {});
    const word = paramDict['word'].normalize().trim();

    /* Retrieve a list of words and authors from the database */
    const rows = await new Promise((res, rej) =>
        db.all('SELECT word, author FROM shiritore ORDER BY postAt;', (err, rows) =>
            err ? rej(err) : res(rows)));

    // TODO: More user-friendly error reporting
    const last = rows.at(-1);
    if ([...last['word']].at(-1) !== [...word][0]) {
        errorEnd(422, 'The word does not fulfil the condition.')(req, res);
        return ;
    }
    if (last['author'] === shirid) {
        errorEnd(422, 'The previous word was submitted by yourself.')(req, res);
        return ;
    }

    /* Insert the new word into the database */
    try {
        db.serialize(() => {
            const throwError = err => { if (err) throw err; };
            db.exec('BEGIN TRANSACTION;', throwError);
            db.run(`INSERT OR IGNORE INTO shiritore
                        ( word, author ) VALUES ( $word, $author )`,
                { $word: word, $author: shirid }, throwError);
            db.exec('COMMIT TRANSACTION;', throwError);
        });
    } catch (err) {
        errorEnd(500, err)(req, res);
        return ;
    }

    /* Redirect with GET request */
    res.writeHead(303, { 'Location': './' });
    res.end();
}

/*****************************************************************************/

/* If necessary, create Shiritore table and insert the first row */
try {
    db.serialize(() => {
        const throwError = err => { if (err) throw err; };
        db.exec('BEGIN TRANSACTION;', throwError);
        db.exec(`CREATE TABLE IF NOT EXISTS shiritore (
                    word    TEXT    NOT NULL,
                    author  TEXT    NOT NULL,
                    postAt  NUMERIC NOT NULL DEFAULT ( datetime() ),
                    PRIMARY KEY ( word ));`, throwError);
        db.exec('COMMIT TRANSACTION;', throwError);
        db.exec(`INSERT OR IGNORE INTO shiritore
                    ( word, author ) VALUES ( 'しりとり', '' );`, throwError);
    });
} catch (err) {
    console.error(err);
    process.exit(-1);
}

/* Start Shiritore server */
http.createServer((req, res) => {
    /*
     * Parse the cookie.
     * The Cookie header has a names and values are encoded in name-value tuples separated by "; ",
     * with a '=' between the name and the value.
     */
    const cookieList = (req.headers['cookie'] || '').split('; ');
    const cookieDict = cookieList.reduce((cookieDict, elem) => {
        const [ name, value ] = elem.split('=');
        cookieDict[name] = value;
        return cookieDict;
    }, {});

    /* Start or update a session */
    const shirid = cookieDict['shirid'] || generateUUID();
    res.appendHeader('Set-Cookie', [
        `shirid=${shirid}`,
        `Expires=${(new Date(Date.now() + PERIOD)).toUTCString()}`,
        'SameSite=None',
        'Secure',
        'HttpOnly',
    ].join('; '));

    /* Process each request */
    const processor = {
        'get': getShiritore,
        'post': postShiritore,
    };
    (processor[req.method.toLowerCase()] || errorEnd(405))(req, res, shirid);
}).listen(PORT, _ => {
    console.log(`Shiritore is listening on ${PORT}.`);
});
