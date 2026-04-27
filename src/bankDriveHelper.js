const { google } = require("googleapis");
const { Readable } = require("stream");

const SCOPES = ["https://www.googleapis.com/auth/drive"];

function getAuth() {
  const credentials = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  return new google.auth.GoogleAuth({
    credentials,
    scopes: SCOPES,
  });
}

/**
 * 指定フォルダ内のCSVファイル一覧を取得
 * @param {string} folderId - Google Drive フォルダID
 * @returns {Promise<Array>} CSVファイルのリスト
 */
async function listCsvFiles(folderId) {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.list({
    q: `'${folderId}' in parents and mimeType='text/csv' and trashed=false`,
    spaces: "drive",
    fields: "files(id, name, createdTime, modifiedTime)",
    pageSize: 100,
  });

  return response.data.files || [];
}

/**
 * ファイルの内容をバッファとして取得
 * @param {string} fileId - Google Drive ファイルID
 * @returns {Promise<Buffer>} ファイルの内容
 */
async function downloadFile(fileId) {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });

  const response = await drive.files.get(
    { fileId, alt: "media" },
    { responseType: "stream" }
  );

  return streamToBuffer(response.data);
}

/**
 * ファイルをフォルダに移動
 * @param {string} fileId - Google Drive ファイルID
 * @param {string} targetFolderId - 移動先フォルダID
 */
async function moveFile(fileId, targetFolderId) {
  const auth = getAuth();
  const drive = google.drive({ version: "v3", auth });

  const file = await drive.files.get({
    fileId,
    fields: "parents",
  });

  const previousParents = file.data.parents;

  await drive.files.update({
    fileId,
    addParents: targetFolderId,
    removeParents: previousParents.join(","),
    fields: "id, parents",
  });
}

/**
 * ReadableStream を Buffer に変換する
 */
function streamToBuffer(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

module.exports = {
  listCsvFiles,
  downloadFile,
  moveFile,
};
