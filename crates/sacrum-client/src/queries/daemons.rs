pub const DAEMON_FIELDS: &str = r#"
    fragment DaemonFields on Daemon {
        id
        status
        name
        display_name
        enrolled_at
        removed_at
        inserted_at
        updated_at
    }
"#;

/// Sacrum excludes removed tombstones from this list.
pub const LIST_FLEET: &str = r#"
    query ListDaemonFleet {
        daemons { ...DaemonFields }
    }
"#;

/// Unknown and foreign ids resolve to null without disclosure.
pub const GET_DAEMON: &str = r#"
    query GetDaemon($id: Uuid4!) {
        daemon(id: $id) { ...DaemonFields }
    }
"#;

pub const DAEMON_CREDENTIAL_METADATA_FIELDS: &str = r#"
    fragment DaemonCredentialMetadataFields on DaemonCredentialMetadata {
        id
        credential_kind
        status
        expires_at
        consumed_at
        revoked_at
        inserted_at
        updated_at
    }
"#;

pub const GET_DAEMON_ENROLLMENT_METADATA: &str = r#"
    query GetDaemonEnrollmentMetadata($id: Uuid4!) {
        daemonEnrollmentMetadata(id: $id) {
            daemon_id
            status
            enrolled_at
            credentials { ...DaemonCredentialMetadataFields }
        }
    }
"#;

pub const CREATE_DAEMON: &str = r#"
    mutation CreateDaemon($name: String) {
        createDaemon(name: $name) {
            daemon { ...DaemonFields }
            enrollment_token
            expires_at
        }
    }
"#;

/// Omitted `name` leaves it unchanged; `name: null` clears it.
pub const RENAME_DAEMON: &str = r#"
    mutation RenameDaemon($id: Uuid4!, $name: String) {
        renameDaemon(id: $id, name: $name) { ...DaemonFields }
    }
"#;

pub const REVOKE_DAEMON: &str = r#"
    mutation RevokeDaemon($id: Uuid4!) {
        revokeDaemon(id: $id) { ...DaemonFields }
    }
"#;

pub const UNREGISTER_DAEMON: &str = r#"
    mutation UnregisterDaemon($id: Uuid4!) {
        unregisterDaemon(id: $id) { ...DaemonFields }
    }
"#;

pub const ROTATE_DAEMON_CREDENTIALS: &str = r#"
    mutation RotateDaemonCredentials($id: Uuid4!) {
        rotateDaemonCredentials(id: $id) {
            daemon { ...DaemonFields }
            enrollment_token
            expires_at
        }
    }
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operations_are_account_scoped_and_project_independent() {
        for operation in [
            LIST_FLEET,
            GET_DAEMON,
            GET_DAEMON_ENROLLMENT_METADATA,
            CREATE_DAEMON,
            RENAME_DAEMON,
            REVOKE_DAEMON,
            UNREGISTER_DAEMON,
            ROTATE_DAEMON_CREDENTIALS,
        ] {
            assert!(
                !operation.contains("project"),
                "daemon operations must not reference a project scope: {operation}"
            );
        }
    }

    #[test]
    fn operations_use_owner_management_field_names() {
        assert!(LIST_FLEET.contains("query ListDaemonFleet"));
        assert!(LIST_FLEET.contains("daemons { ...DaemonFields }"));
        assert!(GET_DAEMON.contains("query GetDaemon($id: Uuid4!)"));
        assert!(GET_DAEMON.contains("daemon(id: $id)"));
        assert!(GET_DAEMON_ENROLLMENT_METADATA.contains("daemonEnrollmentMetadata(id: $id)"));
        assert!(
            GET_DAEMON_ENROLLMENT_METADATA
                .contains("credentials { ...DaemonCredentialMetadataFields }")
        );
        assert!(CREATE_DAEMON.contains("mutation CreateDaemon($name: String)"));
        assert!(CREATE_DAEMON.contains("createDaemon(name: $name)"));
        assert!(CREATE_DAEMON.contains("enrollment_token"));
        assert!(RENAME_DAEMON.contains("mutation RenameDaemon($id: Uuid4!, $name: String)"));
        assert!(RENAME_DAEMON.contains("renameDaemon(id: $id, name: $name)"));
        assert!(REVOKE_DAEMON.contains("revokeDaemon(id: $id)"));
        assert!(UNREGISTER_DAEMON.contains("unregisterDaemon(id: $id)"));
        assert!(ROTATE_DAEMON_CREDENTIALS.contains("rotateDaemonCredentials(id: $id)"));
    }

    #[test]
    fn safe_metadata_fragment_selects_no_credential_material() {
        for fragment in [DAEMON_FIELDS, DAEMON_CREDENTIAL_METADATA_FIELDS] {
            assert!(
                !fragment.contains("token"),
                "safe projections must not select tokens"
            );
            assert!(
                !fragment.contains("hash"),
                "safe projections must not select token hashes"
            );
        }
        assert!(CREATE_DAEMON.contains("enrollment_token"));
        assert!(ROTATE_DAEMON_CREDENTIALS.contains("enrollment_token"));
    }
}
