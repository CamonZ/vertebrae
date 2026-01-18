//! Chat session repository for CRUD operations on chat sessions and messages
//!
//! Provides a repository pattern implementation for managing Claude PTY chat sessions
//! and their associated message history.

use crate::error::{DbError, DbResult};
use crate::models::{ChatMessage, ChatSession};

use chrono::{DateTime, Utc};
use serde::Deserialize;
use surrealdb::Surreal;
use surrealdb::engine::local::Db;
use surrealdb::sql::Thing;
use tracing::{debug, trace};

/// Repository for chat session CRUD operations
///
/// Encapsulates database queries for chat sessions and messages,
/// providing a clean API that hides the underlying SurrealDB implementation details.
pub struct ChatSessionRepository<'a> {
    client: &'a Surreal<Db>,
}

/// Minimal row for returning session ID
#[derive(Debug, Deserialize)]
struct IdOnly {
    id: Thing,
}

impl<'a> ChatSessionRepository<'a> {
    /// Create a new ChatSessionRepository with the given database client
    pub fn new(client: &'a Surreal<Db>) -> Self {
        Self { client }
    }

    /// Create a new chat session.
    ///
    /// # Arguments
    ///
    /// * `session` - The chat session data to create
    ///
    /// # Returns
    ///
    /// The created ChatSession with its ID populated.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn create_session(&self, session: &ChatSession) -> DbResult<ChatSession> {
        debug!(
            "Creating chat session with working_dir: {:?}",
            session.working_dir
        );
        trace!("Session data: {:?}", session);

        let started_at = session.started_at.to_rfc3339();
        let title_str = match &session.title {
            Some(_) => "$title".to_string(),
            None => "NONE".to_string(),
        };
        let working_dir_str = match &session.working_dir {
            Some(_) => "$working_dir".to_string(),
            None => "NONE".to_string(),
        };
        let ended_at_str = match &session.ended_at {
            Some(dt) => format!("d\"{}\"", dt.to_rfc3339()),
            None => "NONE".to_string(),
        };

        let query = format!(
            r#"CREATE chat_session SET
                title = {},
                working_dir = {},
                started_at = d"{}",
                ended_at = {}"#,
            title_str, working_dir_str, started_at, ended_at_str
        );

        let mut q = self.client.query(&query);

        if let Some(ref t) = session.title {
            q = q.bind(("title", t.clone()));
        }
        if let Some(ref wd) = session.working_dir {
            q = q.bind(("working_dir", wd.clone()));
        }

        let mut result = q.await.map_err(|e| DbError::Query(Box::new(e)))?;

        let created: Option<ChatSession> = result.take(0)?;
        let created = created.ok_or_else(|| DbError::ValidationError {
            message: "No session returned from create operation".to_string(),
        })?;

        debug!(
            "Created chat session with ID: {:?}",
            created.id.as_ref().map(|t| t.id.to_raw())
        );
        Ok(created)
    }

    /// Get a chat session by ID.
    ///
    /// # Arguments
    ///
    /// * `id` - The session ID to fetch (without the "chat_session:" prefix)
    ///
    /// # Returns
    ///
    /// `Some(ChatSession)` if found, `None` otherwise.
    pub async fn get_session(&self, id: &str) -> DbResult<Option<ChatSession>> {
        debug!("Fetching chat session: {}", id);
        let query = format!("SELECT * FROM chat_session:{}", id);
        let mut result = self.client.query(&query).await.map_err(|e| {
            debug!("Failed to fetch session: {}: {}", id, e);
            DbError::Query(Box::new(e))
        })?;
        let session: Option<ChatSession> = result.take(0)?;
        if session.is_some() {
            debug!("Successfully fetched session: {}", id);
        } else {
            debug!("Session not found: {}", id);
        }
        Ok(session)
    }

    /// List all chat sessions in reverse chronological order (most recent first).
    ///
    /// # Arguments
    ///
    /// * `limit` - Optional maximum number of sessions to return
    ///
    /// # Returns
    ///
    /// A vector of chat sessions sorted by started_at descending.
    pub async fn list_sessions(&self, limit: Option<usize>) -> DbResult<Vec<ChatSession>> {
        debug!("Listing chat sessions with limit: {:?}", limit);
        let query = match limit {
            Some(n) => format!(
                "SELECT * FROM chat_session ORDER BY started_at DESC LIMIT {}",
                n
            ),
            None => "SELECT * FROM chat_session ORDER BY started_at DESC".to_string(),
        };
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let sessions: Vec<ChatSession> = result.take(0)?;
        debug!("Found {} chat sessions", sessions.len());
        Ok(sessions)
    }

    /// End a chat session by setting its ended_at timestamp.
    ///
    /// # Arguments
    ///
    /// * `id` - The session ID to end (without the "chat_session:" prefix)
    /// * `ended_at` - The end timestamp
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn end_session(&self, id: &str, ended_at: DateTime<Utc>) -> DbResult<()> {
        debug!("Ending chat session: {}", id);
        let query = format!(
            r#"UPDATE chat_session:{} SET ended_at = d"{}""#,
            id,
            ended_at.to_rfc3339()
        );
        self.client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        Ok(())
    }

    /// Update the title of a chat session.
    ///
    /// # Arguments
    ///
    /// * `id` - The session ID to update (without the "chat_session:" prefix)
    /// * `title` - The new title
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn update_title(&self, id: &str, title: &str) -> DbResult<()> {
        debug!("Updating chat session {} title to: {}", id, title);
        let query = format!("UPDATE chat_session:{} SET title = $title", id);
        self.client
            .query(&query)
            .bind(("title", title.to_string()))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        Ok(())
    }

    /// Add a message to a chat session.
    ///
    /// # Arguments
    ///
    /// * `message` - The chat message to add
    ///
    /// # Returns
    ///
    /// The ID of the created message as a string.
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn add_message(&self, message: &ChatMessage) -> DbResult<String> {
        debug!("Adding message to session: {:?}", message.session_id);
        trace!("Message content length: {} chars", message.content.len());

        let created_at = message.created_at.to_rfc3339();

        let query = format!(
            r#"CREATE chat_message SET
                session_id = {},
                content = $content,
                created_at = d"{}""#,
            message.session_id, created_at
        );

        let mut result = self
            .client
            .query(&query)
            .bind(("content", message.content.clone()))
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        let created: Option<IdOnly> = result.take(0)?;
        let id = created.ok_or_else(|| DbError::ValidationError {
            message: "No ID returned from create operation".to_string(),
        })?;

        let id_str = id.id.id.to_raw();
        debug!("Created chat message with ID: {}", id_str);
        Ok(id_str)
    }

    /// List all messages for a chat session in chronological order.
    ///
    /// # Arguments
    ///
    /// * `session_id` - The session ID to list messages for (without the "chat_session:" prefix)
    ///
    /// # Returns
    ///
    /// A vector of chat messages sorted by created_at ascending (oldest first).
    pub async fn list_messages(&self, session_id: &str) -> DbResult<Vec<ChatMessage>> {
        debug!("Listing messages for session: {}", session_id);
        let query = format!(
            "SELECT * FROM chat_message WHERE session_id = chat_session:{} ORDER BY created_at ASC",
            session_id
        );
        let mut result = self
            .client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;
        let messages: Vec<ChatMessage> = result.take(0)?;
        debug!(
            "Found {} messages for session {}",
            messages.len(),
            session_id
        );
        Ok(messages)
    }

    /// Get all message content concatenated for a session.
    ///
    /// This is useful for replaying a session's terminal output.
    ///
    /// # Arguments
    ///
    /// * `session_id` - The session ID (without the "chat_session:" prefix)
    ///
    /// # Returns
    ///
    /// All message content concatenated in chronological order.
    pub async fn get_session_content(&self, session_id: &str) -> DbResult<String> {
        let messages = self.list_messages(session_id).await?;
        Ok(messages.into_iter().map(|m| m.content).collect::<String>())
    }

    /// Delete a chat session and all its messages.
    ///
    /// # Arguments
    ///
    /// * `id` - The session ID to delete (without the "chat_session:" prefix)
    ///
    /// # Errors
    ///
    /// Returns `DbError::Query` if the database operation fails.
    pub async fn delete_session(&self, id: &str) -> DbResult<()> {
        debug!("Deleting chat session: {}", id);

        // First delete all messages
        let query = format!(
            "DELETE FROM chat_message WHERE session_id = chat_session:{}",
            id
        );
        self.client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        // Then delete the session
        let query = format!("DELETE FROM chat_session:{}", id);
        self.client
            .query(&query)
            .await
            .map_err(|e| DbError::Query(Box::new(e)))?;

        debug!("Deleted chat session: {}", id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::schema::init_schema;
    use surrealdb::engine::local::Mem;

    /// Helper to create an in-memory test database
    async fn setup_test_db() -> Surreal<Db> {
        let client = Surreal::new::<Mem>(()).await.unwrap();
        client.use_ns("vertebrae").use_db("test").await.unwrap();
        init_schema(&client).await.unwrap();
        client
    }

    #[tokio::test]
    async fn test_create_session() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        let session = ChatSession::new(Some("/test/path".to_string()));
        let created = repo.create_session(&session).await.unwrap();

        assert!(created.id.is_some());
        assert_eq!(created.working_dir, Some("/test/path".to_string()));
        assert!(created.ended_at.is_none());
    }

    #[tokio::test]
    async fn test_create_session_with_title() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        let session = ChatSession::new(None).with_title("Test Session");
        let created = repo.create_session(&session).await.unwrap();

        assert!(created.id.is_some());
        assert_eq!(created.title, Some("Test Session".to_string()));
    }

    #[tokio::test]
    async fn test_get_session() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        let session = ChatSession::new(Some("/test".to_string()));
        let created = repo.create_session(&session).await.unwrap();
        let id = created.id_string().unwrap();

        let retrieved = repo.get_session(&id).await.unwrap();
        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().working_dir, Some("/test".to_string()));
    }

    #[tokio::test]
    async fn test_get_session_not_found() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        let result = repo.get_session("nonexistent").await.unwrap();
        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_list_sessions_chronological() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        // Create sessions with different times
        let base_time = Utc::now();
        for i in 0..3 {
            let mut session = ChatSession::new(None);
            session.started_at = base_time + chrono::Duration::seconds(i);
            session.title = Some(format!("Session {}", i));
            repo.create_session(&session).await.unwrap();
        }

        let sessions = repo.list_sessions(None).await.unwrap();
        assert_eq!(sessions.len(), 3);

        // Verify reverse chronological order (most recent first)
        assert_eq!(sessions[0].title, Some("Session 2".to_string()));
        assert_eq!(sessions[1].title, Some("Session 1".to_string()));
        assert_eq!(sessions[2].title, Some("Session 0".to_string()));
    }

    #[tokio::test]
    async fn test_list_sessions_with_limit() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        for _ in 0..5 {
            let session = ChatSession::new(None);
            repo.create_session(&session).await.unwrap();
        }

        let sessions = repo.list_sessions(Some(2)).await.unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[tokio::test]
    async fn test_end_session() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        let session = ChatSession::new(None);
        let created = repo.create_session(&session).await.unwrap();
        let id = created.id_string().unwrap();

        assert!(created.ended_at.is_none());

        let end_time = Utc::now();
        repo.end_session(&id, end_time).await.unwrap();

        let updated = repo.get_session(&id).await.unwrap().unwrap();
        assert!(updated.ended_at.is_some());
    }

    #[tokio::test]
    async fn test_update_title() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        let session = ChatSession::new(None);
        let created = repo.create_session(&session).await.unwrap();
        let id = created.id_string().unwrap();

        repo.update_title(&id, "New Title").await.unwrap();

        let updated = repo.get_session(&id).await.unwrap().unwrap();
        assert_eq!(updated.title, Some("New Title".to_string()));
    }

    #[tokio::test]
    async fn test_add_and_list_messages() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        let session = ChatSession::new(None);
        let created = repo.create_session(&session).await.unwrap();
        let session_id = created.id_string().unwrap();
        let session_thing = created.id.unwrap();

        // Add messages
        let base_time = Utc::now();
        for i in 0..3 {
            let mut message = ChatMessage::new(session_thing.clone(), format!("Message {}", i));
            message.created_at = base_time + chrono::Duration::seconds(i);
            repo.add_message(&message).await.unwrap();
        }

        let messages = repo.list_messages(&session_id).await.unwrap();
        assert_eq!(messages.len(), 3);

        // Verify chronological order
        assert!(messages[0].content.contains("0"));
        assert!(messages[1].content.contains("1"));
        assert!(messages[2].content.contains("2"));
    }

    #[tokio::test]
    async fn test_get_session_content() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        let session = ChatSession::new(None);
        let created = repo.create_session(&session).await.unwrap();
        let session_id = created.id_string().unwrap();
        let session_thing = created.id.unwrap();

        // Add messages
        for content in ["Hello", " ", "World"] {
            let message = ChatMessage::new(session_thing.clone(), content);
            repo.add_message(&message).await.unwrap();
        }

        let content = repo.get_session_content(&session_id).await.unwrap();
        assert_eq!(content, "Hello World");
    }

    #[tokio::test]
    async fn test_delete_session() {
        let client = setup_test_db().await;
        let repo = ChatSessionRepository::new(&client);

        let session = ChatSession::new(None);
        let created = repo.create_session(&session).await.unwrap();
        let session_id = created.id_string().unwrap();
        let session_thing = created.id.unwrap();

        // Add a message
        let message = ChatMessage::new(session_thing, "Test message");
        repo.add_message(&message).await.unwrap();

        // Delete session
        repo.delete_session(&session_id).await.unwrap();

        // Verify session is gone
        let result = repo.get_session(&session_id).await.unwrap();
        assert!(result.is_none());

        // Verify messages are gone too
        let messages = repo.list_messages(&session_id).await.unwrap();
        assert!(messages.is_empty());
    }
}
