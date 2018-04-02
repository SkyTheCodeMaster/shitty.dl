const config = require(process.argv[2] || "./config.json");

const _ = require("lodash");

const fs = require("fs");
const path = require("path");
const url = require("url");
const util = require("util");

const express = require("express");
const bb = require("express-busboy");
const handlebars = require("express-handlebars");
const promBundle = require("express-prom-bundle");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const helpers = require("handlebars-helpers")();
const dateformat = require("helper-dateformat");
const Finder = require("fs-finder");
const moment = require("moment");

const paginator = new require("paginator")(48, 8);
const crypto = require("crypto");
const Highlights = require("highlights");
const highlighter = new Highlights({ scopePrefix: config.oldPasteThemeCompatibility ? "" : "syntax--" });
const sanitizeFilename = require("sanitize-filename");
const CodeRain = require("coderain");
const cr = new CodeRain(("#").repeat(config.fileLength || 4));
const filesize = require("filesize");

const app = express();
const statCache = {};

const pathname = new url.URL(config.url).pathname;

if (!config.sessionSecret) {
	console.error("Please put a secure random value in config.sessionSecret");
	process.exit(0);
}

if (config.languagePackages) {
  config.languagePackages.forEach(package => {
    try {
      const pkg = require.resolve(`${package}/package.json`);
      highlighter.requireGrammarsSync({ modulePath: pkg });
    } catch (e) {
      console.warn(`Could not find/load language package ${package}`)
    }
  });
} 

app.engine(".hbs", handlebars({ defaultLayout: "main", extname: ".hbs", helpers: _.merge(helpers, { "dateformat" : dateformat }) }));
app.set("view engine", ".hbs");
app.use(pathname, express.static("public"));
app.use(pathname, express.static(config.imagePath));
app.use(session({
	secret: config.sessionSecret,
	cookie: {},
	resave: false,
	saveUninitialized: true,
	store: new SQLiteStore
}));

bb.extend(app, {
	upload: true
});

function error(req, res, error) {
	console.error(util.inspect(error, {
		depth: null,
		colors: true,
		showHidden: true
	}));

	if (req.xhr || req.headers.accept.indexOf('json') > -1) {
		res.json({ ok: false, error });
	} else {
		res.render("error", { errorText: error });
	}
}

function moveFile(oldPath, newPath, callback) {
	fs.rename(oldPath, newPath, err => {
		if (err) {
			if (err.code === "EXDEV") {
				copy();
			} else {
				callback(err);
			}

			return;
		}

		callback();
	});

	function copy() {
		const readStream = fs.createReadStream(oldPath);
		const writeStream = fs.createWriteStream(newPath);

		readStream.on("error", callback);
		writeStream.on("error", callback);

		readStream.on("close", () => fs.unlink(oldPath, callback));

		readStream.pipe(writeStream);
	}
}

app.use(promBundle({
	includeMethod: true,
	includePath: true,
	normalizePath: req => {
		return url.parse(req.originalUrl).pathname;
	}
}));

app.get([pathname, pathname+"home"], (req, res) => {
	res.render("home", {
		config: _.omit(config, ["password", "sessionSecret"]),
		authed: req.session && req.session.authed,
		pathname
	});
});

function auth(req, res, next) {
	if (!req.session || !req.session.authed) {
		return res.redirect(pathname);
	}

	next();
}

app.post(pathname+"login", (req, res) => {
	if (!req.body.password) return error(req, res, "No password specified.");
	if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");

	req.session.authed = true;
	req.session.save();

	res.redirect(pathname+"gallery");
});

app.get(pathname+"upload", auth, (req, res) => {
	res.render("upload", {
		config: _.omit(config, ["password", "sessionSecret"]),
		pageTemplate: "upload",
		pathname
	});
});

app.post(pathname+"upload", (req, res) => {
	if (!req.files || !req.files.file) return error(req, res, "No file specified.");

	if (!req.session || !req.session.authed) {
		if (!req.body.password) return error(req, res, "No password specified.");
		if (crypto.createHash("sha256").update(req.body.password).digest("hex") !== config.password) return error(req, res, "Incorrect password.");
	}

	const file = req.files.file;
	const ext = req.query.ext ? sanitizeFilename(req.query.ext) : path.extname(file.filename);

	if (ext.toLowerCase() === ".php") return error(req, res, "Disallowed file type.");

	let name;
	let attempts = 0;

	do {
		if (attempts === 0 && req.body.name && req.body.name.length > 0) {
			name = req.body.name.replace(/[^A-Za-z0-9_\-]/g, "_");
		} else {
			name = cr.next();
		}

		attempts++;

		if (attempts > 20) {
			return error(req, res, "Could not generate unique filename after 20 attempts.");
		}
	} while (fs.existsSync(`${config.imagePath}/${name}${ext}`));

	moveFile(file.file, `${config.imagePath}/${name}${ext}`, err => {
		if (err) return console.log(JSON.stringify(err));

		if (typeof req.query.paste !== "undefined") {
			name = "paste/" + name;
		}

		if (req.body.online === "yes") {
			res.redirect(`${config.url}${name}${ext}`);
		} else {
			res.json({
				ok: true,
				url: `${config.url}${name}${ext}`
			});
		}
	});
});

app.get(pathname+"paste/:file", (req, res) => {
	const filename = sanitizeFilename(req.params.file);
	const filePath = path.join(config.imagePath, filename);

	if (!filePath) return res.status(404).send("File not found");

	try {
		const stats = fs.statSync(filePath);

    console.log(stats);

		if (!stats.isFile()) return res.status(404).send("File not found");
		if (stats.size > 2 ** 19) return error(req, res, `File too large (${filesize(stats.size)})`);

		const html = highlighter.highlightSync({filePath});

		res.render("paste", {
			paste: html,
			style: config.pasteThemePath || "https://atom.github.io/highlights/examples/atom-dark.css",
			name: filename,
			pathname,
			layout: false
		});
	} catch (err) {
		error(req, res, err);
	}
});

function fileListing(mask, pageTemplate, route, req, res) {
	if (req.query.extensions) {
		mask = `*.<(${req.query.extensions.split(",").join("|")})$>`;
	}

	const finder = Finder.from(config.imagePath);
	if (req.query.start) finder.date(">", moment(req.query.start).set({hours: 0, minutes: 0, seconds: 0, milliseconds: 0}).toISOString());
	if (req.query.end) finder.date("<", moment(req.query.end).set({hours: 0, minutes: 0, seconds: 0, milliseconds: 0}).add(1, "day").toISOString());
	const files = finder.findFiles(mask);

	let page = typeof req.params.page !== "undefined" ? parseInt(req.params.page) : 0;
	page = Math.min(Math.max(0, page), files.length);

	const paginationInfo = paginator.build(files.length, page);

	const fullFiles = _.reverse(_.sortBy(_.map(files, f => {
		if (statCache[f]) return statCache[f];

		const stat = fs.statSync(`${f}`);
		const o = {
			name: path.relative(config.imagePath, f),
			size: stat.size,
			mtime: stat.mtime
		};

		statCache[f] = o;

		return o;
	}), "mtime"));

	res.render(pageTemplate, {
		route,
		pageTemplate,
		query: url.parse(req.url).query,
		paginationInfo,
		pages: _.range(paginationInfo.first_page, paginationInfo.last_page + 1),
		files: _.slice(fullFiles, paginationInfo.first_result, paginationInfo.last_result + 1),
		pathname
	});
}

app.get(pathname+"gallery/:page?", auth, (req, res) => fileListing("*.<(jpeg|jpg|png|gif)$>", "gallery", pathname+"gallery", req, res));
app.get(pathname+"list/:page?", auth, (req, res) => fileListing("*.*", "list", pathname+"list", req, res));

app.listen(config.listen);
