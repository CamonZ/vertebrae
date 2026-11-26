use serde_json::Value;
use std::{
    fs,
    io::{self, ErrorKind, Read},
    path::PathBuf,
};

use crate::private_file;

const MAX_TRANSCRIPT_BYTES: u64 = 16 * 1024 * 1024;

pub(crate) async fn load(session_id: String) -> io::Result<Vec<Value>> {
    tokio::task::spawn_blocking(move || {
        let file = match fs::File::open(path(&session_id)?) {
            Ok(file) => file,
            Err(error) if error.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(error),
        };
        let mut bytes = Vec::new();
        file.take(MAX_TRANSCRIPT_BYTES + 1)
            .read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_TRANSCRIPT_BYTES {
            return Err(too_large());
        }
        Ok(serde_json::from_slice(&bytes)?)
    })
    .await?
}

fn too_large() -> io::Error {
    io::Error::new(
        ErrorKind::InvalidData,
        "ACP transcript exceeds the storage limit",
    )
}

pub(crate) async fn save(session_id: String, messages: Vec<Value>) -> io::Result<()> {
    tokio::task::spawn_blocking(move || {
        let path = path(&session_id)?;
        let directory = path.parent().expect("transcript path has a parent");
        if !messages.is_empty() {
            fs::create_dir_all(directory)?;
        } else if !directory.try_exists()? {
            return Ok(());
        }
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(directory.join(".transcripts.lock"))?;
        fs2::FileExt::lock_exclusive(&lock)?;
        if messages.is_empty() {
            return private_file::remove(&path);
        }
        let bytes = serde_json::to_vec(&messages)?;
        if bytes.len() as u64 > MAX_TRANSCRIPT_BYTES {
            return Err(too_large());
        }
        private_file::replace(&path, &bytes)
    })
    .await?
}

fn path(id: &str) -> io::Result<PathBuf> {
    super::annotations::validate_session_id(id)
        .map_err(|error| io::Error::new(ErrorKind::InvalidInput, error))?;
    let root = vertebrae_installer::data_dir().map_err(io::Error::other)?;
    Ok(root.join("acp-transcripts").join(format!("{id}.json")))
}
