CREATE TABLE tasks_v2 (
  id TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL REFERENCES sessions(id),
  workerId TEXT NOT NULL REFERENCES digital_workers(id),
  workerName TEXT NOT NULL,
  uploadId TEXT REFERENCES uploads(id),
  input TEXT NOT NULL,
  requestKey TEXT NOT NULL UNIQUE,
  requestDigest TEXT NOT NULL,
  createdAt TEXT NOT NULL
);
INSERT INTO tasks_v2 SELECT id,sessionId,workerId,workerName,uploadId,input,requestKey,requestDigest,createdAt FROM tasks;
DROP TABLE tasks;
ALTER TABLE tasks_v2 RENAME TO tasks;
CREATE INDEX task_created ON tasks(createdAt,id);
CREATE INDEX task_session ON tasks(sessionId,createdAt,id);
CREATE INDEX session_worker ON sessions(workerId,createdAt,id);
