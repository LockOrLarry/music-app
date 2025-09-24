const sqlite3 = require("sqlite3").verbose();
const db = new sqlite3.Database("./musicapp.db");

// Create tables if not exist
db.serialize(() => {
  db.run(`
  CREATE TABLE IF NOT EXISTS favourites (
    user_id INTEGER NOT NULL,
    track_id INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);
});

module.exports = db;
