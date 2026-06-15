const { parseKiroSessions } = require('./dist/core/parser-kiro');
const path = require('path');

const kiroDir = "C:\\Users\\DELL\\AppData\\Roaming\\Kiro\\User\\globalStorage\\kiro.kiroagent\\workspace-sessions";
const wsPath = path.join(kiroDir, "ZDpcUHJvamVjdHNcVENJU2FsZVBvcnRhbFxBUElTYWxlUG9ydGFs");
const sessions = parseKiroSessions(wsPath, "ZDpcUHJvamVjdHNcVENJU2FsZVBvcnRhbFxBUElTYWxlUG9ydGFs");
console.log(JSON.stringify(sessions, null, 2));
