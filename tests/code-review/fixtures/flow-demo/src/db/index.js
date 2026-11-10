import sqlite3 from 'sqlite3';

const connection = new sqlite3.Database('app.db');

export const db = {
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      connection.run(sql, params, function onDone(error) {
        if (error) reject(error);
        else resolve({ lastID: this.lastID, changes: this.changes });
      });
    });
  },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      connection.get(sql, params, (error, row) => {
        if (error) reject(error);
        else resolve(row);
      });
    });
  },
};
