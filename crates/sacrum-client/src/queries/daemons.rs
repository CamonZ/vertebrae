//! GraphQL operations for the owner-scoped daemon fleet management surface.
//!
//! These operations are account-authenticated and project-independent: none of
//! them reference a project id. Safe daemon metadata and short-lived bootstrap
//! credentials are deliberately separate projections; only the `*Bootstrap`
//! payloads ever carry token material.

/// Safe daemon fleet metadata. No credential material is reachable through
/// this fragment.
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

/// Owner's active fleet. Sacrum excludes `removed` tombstones from this list.
pub const LIST_FLEET: &str = r#"
    query ListDaemonFleet {
        daemons { ...DaemonFields }
    }
"#;

/// Owner-scoped daemon read. Tombstones stay readable; unknown and foreign ids
/// resolve to `null` without disclosure.
pub const GET_DAEMON: &str = r#"
    query GetDaemon($id: Uuid4!) {
        daemon(id: $id) { ...DaemonFields }
    }
"#;

/// Safe credential audit projection. Exposes credential kind, status and
/// timestamps only; token hashes are never selectable.
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

/// Owner-scoped enrollment metadata for one daemon, including its credential
/// audit trail.
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

/// Provision a daemon and return its one-time bootstrap credential.
/// The `name` argument is optional and omitted entirely when not supplied.
pub const CREATE_DAEMON: &str = r#"
    mutation CreateDaemon($name: String) {
        createDaemon(name: $name) {
            daemon { ...DaemonFields }
            enrollment_token
            expires_at
        }
    }
"#;

/// Rename through Sacrum's shared naming policy. Omitting `name` leaves the
/// current value unchanged; `name: null` clears it.
pub const RENAME_DAEMON: &str = r#"
    mutation RenameDaemon($id: Uuid4!, $name: String) {
        renameDaemon(id: $id, name: $name) { ...DaemonFields }
    }
"#;

/// Terminal, idempotent revocation. Invalidates every credential and kills the
/// daemon's connected session.
pub const REVOKE_DAEMON: &str = r#"
    mutation RevokeDaemon($id: Uuid4!) {
        revokeDaemon(id: $id) { ...DaemonFields }
    }
"#;

/// Soft-tombstone unregister. Refused conservatively while a session is
/// connected or enrollment history lacks proven work ownership.
pub const UNREGISTER_DAEMON: &str = r#"
    mutation UnregisterDaemon($id: Uuid4!) {
        unregisterDaemon(id: $id) { ...DaemonFields }
    }
"#;

/// Invalidate prior credentials and issue a fresh one-time bootstrap on the
/// same identity.
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
        // Token material appears only in the two short-lived bootstrap payloads.
        assert!(CREATE_DAEMON.contains("enrollment_token"));
        assert!(ROTATE_DAEMON_CREDENTIALS.contains("enrollment_token"));
    }
}
