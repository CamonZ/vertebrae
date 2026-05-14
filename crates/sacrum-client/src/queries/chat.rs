//! GraphQL queries and mutations for the sacrum live chat.
//!
//! Mirrors the Absinthe types in `lib/sacrum_web/graphql/types/chat_types.ex`.

pub const CHAT_SESSION_FIELDS: &str = r#"
    fragment ChatSessionFields on ChatSession {
        id
        project_id
        status
        session_kind
        started_at
        ended_at
        stop_requested_at
        public_metadata
        inserted_at
        updated_at
    }
"#;

pub const CHAT_MESSAGE_FIELDS: &str = r#"
    fragment ChatMessageFields on ChatMessage {
        id
        project_id
        chat_session_id
        role
        content
        content_format
        client_message_id
        metadata
        inserted_at
        updated_at
    }
"#;

pub const CREATE_CHAT_SESSION: &str = r#"
    mutation CreateChatSession(
        $project_id: Uuid4!,
        $session_kind: String,
        $public_metadata: Json
    ) {
        create_chat_session(
            project_id: $project_id,
            session_kind: $session_kind,
            public_metadata: $public_metadata
        ) {
            ...ChatSessionFields
        }
    }
"#;

pub const GET_CHAT_SESSION: &str = r#"
    query GetChatSession($project_id: Uuid4!, $id: Uuid4!) {
        chat_session(project_id: $project_id, id: $id) {
            ...ChatSessionFields
        }
    }
"#;

pub const LIST_CHAT_MESSAGES: &str = r#"
    query ListChatMessages(
        $project_id: Uuid4!,
        $chat_session_id: Uuid4!,
        $limit: Int,
        $after: Datetime
    ) {
        chat_messages(
            project_id: $project_id,
            chat_session_id: $chat_session_id,
            limit: $limit,
            after: $after
        ) {
            ...ChatMessageFields
        }
    }
"#;

pub const SEND_CHAT_MESSAGE: &str = r#"
    mutation SendChatMessage(
        $project_id: Uuid4!,
        $chat_session_id: Uuid4!,
        $content: String!,
        $content_format: String,
        $client_message_id: String,
        $metadata: Json
    ) {
        send_chat_message(
            project_id: $project_id,
            chat_session_id: $chat_session_id,
            content: $content,
            content_format: $content_format,
            client_message_id: $client_message_id,
            metadata: $metadata
        ) {
            ...ChatMessageFields
        }
    }
"#;
