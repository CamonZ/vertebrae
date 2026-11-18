//! Versioned on-disk catalog and compatibility with the former split maps.

use super::*;

const VERSION: u64 = 2;

#[derive(Serialize)]
struct DiskCatalog<'a> {
    version: u64,
    #[serde(flatten)]
    catalog: &'a Catalog,
}

pub(super) fn encode(catalog: &Catalog) -> Result<Vec<u8>, CommandError> {
    serde_json::to_vec(&DiskCatalog {
        version: VERSION,
        catalog,
    })
    .map_err(|_| error())
}

pub(super) fn decode(bytes: &[u8]) -> Result<Catalog, CommandError> {
    let mut value: Value = serde_json::from_slice(bytes).map_err(|_| error())?;
    let fields = value.as_object_mut().ok_or_else(error)?;
    let catalog = match fields.remove("version") {
        Some(version) if version.as_u64() == Some(VERSION) => {
            serde_json::from_value(value).map_err(|_| error())?
        }
        None => {
            let chats: BTreeMap<String, LegacyRecord<String>> =
                serde_json::from_value(fields.remove("records").ok_or_else(error)?)
                    .map_err(|_| error())?;
            let threads: BTreeMap<String, BTreeMap<Uuid, LegacyRecord<Uuid>>> =
                match fields.remove("threads") {
                    Some(threads) => serde_json::from_value(threads).map_err(|_| error())?,
                    None => BTreeMap::new(),
                };

            let mut catalog: Catalog = serde_json::from_value(value).map_err(|_| error())?;
            if !catalog.projects.is_empty() {
                return Err(error());
            }

            for (scoped_id, record) in chats {
                let (project, id) = scoped_id.split_once('/').ok_or_else(error)?;
                if id != record.remote.chat_id {
                    return Err(error());
                }
                *catalog.upsert(project, &EntityKey::chat(id)) = record.into_record();
            }

            for (project, records) in threads {
                for (id, record) in records {
                    if id != record.remote.chat_id {
                        return Err(error());
                    }
                    *catalog.upsert(&project, &EntityKey::Thread(ThreadId(id))) =
                        record.into_record();
                }
            }
            catalog
        }
        Some(_) => return Err(error()),
    };

    if catalog.migration.version > migration::VERSION {
        return Err(error());
    }
    Ok(catalog)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LegacyRemote<K> {
    chat_id: K,
    revision: u64,
    payload: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct LegacyRecord<K> {
    remote: LegacyRemote<K>,
    desired: Option<Value>,
    mutation_id: String,
    #[serde(default)]
    conflicted: bool,
    #[serde(default)]
    import_only: bool,
    #[serde(default)]
    rejection_code: Option<String>,
}

impl<K> LegacyRecord<K> {
    fn into_record(self) -> Record {
        Record {
            remote: entity::Remote {
                revision: self.remote.revision,
                payload: self.remote.payload,
            },
            desired: self.desired,
            mutation_id: self.mutation_id,
            conflicted: self.conflicted,
            import_only: self.import_only,
            rejection_code: self.rejection_code,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mixed_legacy_outbox_preserves_pending_revision_mutation_and_rejection_on_upgrade() {
        let uuid = "236459b0-a0eb-40cc-a2b0-7401d5302d78";
        // Equal raw IDs in the same project must retain separate namespaces.
        let legacy = json!({
            "records": {
                (format!("project/{uuid}")): {
                    "remote": {"chatId": uuid, "revision": 3, "payload": {"deleted": false}},
                    "desired": {"deleted": true}, "mutation_id": "chat-mutation",
                    "conflicted": true
                }
            },
            "threads": {"project": {(uuid): {
                "remote": {"chatId": uuid, "revision": 0, "payload": null},
                "desired": {"parent_chat_id": uuid}, "mutation_id": "thread-mutation",
                "rejection_code": "not_found"
            }}},
            "unmapped": ["local-only"],
            "migration": {"version": 1, "pending": {}, "verified": []}
        });

        let catalog = decode(&serde_json::to_vec(&legacy).unwrap()).unwrap();
        let chat = EntityKey::chat(uuid);
        let thread = EntityKey::Thread(ThreadId(Uuid::parse_str(uuid).unwrap()));

        let chat_record = catalog.record("project", &chat).unwrap();
        let thread_record = catalog.record("project", &thread).unwrap();
        assert_eq!(chat_record.remote.revision, 3);
        assert_eq!(chat_record.mutation_id, "chat-mutation");
        assert!(chat_record.tombstoned() && chat_record.conflicted);
        assert_eq!(thread_record.mutation_id, "thread-mutation");
        assert_eq!(thread_record.rejection_code.as_deref(), Some("not_found"));
        assert_eq!(thread_record.desired, Some(json!({"parent_chat_id": uuid})));
        assert_eq!(catalog.unmapped, ["local-only"]);
        assert_eq!(catalog.migration.version, 1);

        let encoded = encode(&catalog).unwrap();
        let disk: Value = serde_json::from_slice(&encoded).unwrap();
        assert_eq!(disk["version"], 2);
        assert!(disk.get("records").is_none() && disk.get("threads").is_none());
        assert_eq!(
            disk["projects"]["project"][format!("chat:{uuid}")]["remote"]["revision"],
            3
        );
        assert_eq!(
            disk["projects"]["project"][format!("thread:{uuid}")]["mutation_id"],
            "thread-mutation"
        );
        assert_eq!(encode(&decode(&encoded).unwrap()).unwrap(), encoded);
    }

    #[test]
    fn loader_rejects_invalid_disk_versions_and_invalid_thread_keys() {
        for bytes in [
            br#"{"version":3,"unmapped":[]}"#.as_slice(),
            br#"{"version":null,"unmapped":[]}"#.as_slice(),
            br#"{"version":2,"projects":{"p":{"thread:not-a-uuid":{}}},"unmapped":[]}"#.as_slice(),
        ] {
            assert!(decode(bytes).is_err());
        }
        assert!(decode(br#"{"records":{},"unmapped":[]}"#).is_ok());
    }
}
