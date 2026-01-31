//! Chat session service trait and implementation
//!
//! Provides the main abstraction layer for chat session operations. The `ChatSessionService` trait
//! defines the interface for all chat session management operations, including CRUD operations
//! for chat sessions and their messages.

use crate::error::{ServiceError, ServiceResult};
use crate::models::{ChatMessage, ChatSession};
use async_trait::async_trait;
use std::sync::Arc;
use vertebrae_db::Database;

/// Event representing a chat session mutation for cache invalidation
#[derive(Debug, Clone)]
pub enum ChatSessionMutationEvent {
    /// Chat session was created
    SessionCreated { id: String },
    /// Chat session was updated
    SessionUpdated { id: String },
    /// Message was added to session
    MessageAdded { id: String, session_id: String },
}

/// Callback for chat session mutation events - fires after each mutation completes
pub type ChatSessionMutationCallback = Arc<dyn Fn(ChatSessionMutationEvent) + Send + Sync>;

/// Service trait for chat session management operations
///
/// This trait defines the interface for all chat session-related business logic.
/// It abstracts over the database layer, allowing both CLI and GUI to
/// share the same operations while enabling easy testing through mocks.
///
/// # Object Safety
///
/// This trait is object-safe, enabling dynamic dispatch when needed.
#[async_trait]
pub trait ChatSessionService: Send + Sync {
    /// Create a new chat session
    ///
    /// # Arguments
    ///
    /// * `session` - The chat session data to create
    ///
    /// # Returns
    ///
    /// The ID of the created session.
    async fn create_session(&self, session: ChatSession) -> ServiceResult<String>;

    /// Get a chat session by ID
    ///
    /// ID lookups are case-insensitive.
    async fn get_session(&self, id: &str) -> ServiceResult<Option<ChatSession>>;

    /// List all chat sessions in reverse chronological order (most recent first)
    ///
    /// # Arguments
    ///
    /// * `limit` - Optional maximum number of sessions to return
    ///
    /// # Returns
    ///
    /// A vector of chat sessions sorted by started_at descending.
    async fn list_sessions(&self, limit: Option<usize>) -> ServiceResult<Vec<ChatSession>>;

    /// End a chat session by setting its ended_at timestamp
    ///
    /// # Arguments
    ///
    /// * `id` - The session ID to end
    ///
    /// # Returns
    ///
    /// Unit on success.
    async fn end_session(&self, id: &str) -> ServiceResult<()>;

    /// Update the title of a chat session
    ///
    /// # Arguments
    ///
    /// * `id` - The session ID to update
    /// * `title` - The new title
    ///
    /// # Returns
    ///
    /// Unit on success.
    async fn update_title(&self, id: &str, title: &str) -> ServiceResult<()>;

    /// Add a message to a chat session
    ///
    /// # Arguments
    ///
    /// * `message` - The chat message to add
    ///
    /// # Returns
    ///
    /// The ID of the created message.
    async fn add_message(&self, message: ChatMessage) -> ServiceResult<String>;

    /// List all messages for a chat session in chronological order
    ///
    /// # Arguments
    ///
    /// * `session_id` - The session ID to list messages for
    ///
    /// # Returns
    ///
    /// A vector of chat messages sorted by created_at ascending (oldest first).
    async fn list_messages(&self, session_id: &str) -> ServiceResult<Vec<ChatMessage>>;

    /// Get all message content concatenated for a session
    ///
    /// This is useful for replaying a session's terminal output.
    ///
    /// # Arguments
    ///
    /// * `session_id` - The session ID
    ///
    /// # Returns
    ///
    /// All message content concatenated in chronological order.
    async fn get_session_content(&self, session_id: &str) -> ServiceResult<String>;

    /// Delete a chat session and all its messages
    ///
    /// # Arguments
    ///
    /// * `id` - The session ID to delete
    ///
    /// # Returns
    ///
    /// Unit on success.
    async fn delete_session(&self, id: &str) -> ServiceResult<()>;
}

/// Default implementation of ChatSessionService backed by Database
pub struct DefaultChatSessionService {
    db: Database,
    /// Optional callback for mutations (cache invalidation, notifications, etc.)
    mutation_callback: Option<ChatSessionMutationCallback>,
}

impl DefaultChatSessionService {
    /// Create a new DefaultChatSessionService that owns the database
    pub fn new(db: Database) -> Self {
        Self {
            db,
            mutation_callback: None,
        }
    }

    /// Create a new DefaultChatSessionService with a mutation callback
    ///
    /// The callback fires after each mutation completes, enabling cache invalidation
    /// or other side effects in consumers (CLI, GUI, etc.).
    pub fn with_callback(db: Database, callback: ChatSessionMutationCallback) -> Self {
        Self {
            db,
            mutation_callback: Some(callback),
        }
    }

    /// Set the mutation callback
    pub fn set_callback(&mut self, callback: ChatSessionMutationCallback) {
        self.mutation_callback = Some(callback);
    }
}

#[async_trait]
impl ChatSessionService for DefaultChatSessionService {
    async fn create_session(&self, session: ChatSession) -> ServiceResult<String> {
        let db_session = session.to_db();
        let created = self.db.chat_sessions().create_session(&db_session).await?;

        let id = created
            .id_string()
            .ok_or_else(|| ServiceError::validation_failed("No ID returned from create"))?;

        if let Some(ref callback) = self.mutation_callback {
            callback(ChatSessionMutationEvent::SessionCreated { id: id.clone() });
        }

        Ok(id)
    }

    async fn get_session(&self, id: &str) -> ServiceResult<Option<ChatSession>> {
        let result = self.db.chat_sessions().get_session(id).await?;
        Ok(result.map(|db_session| db_session.into()))
    }

    async fn list_sessions(&self, limit: Option<usize>) -> ServiceResult<Vec<ChatSession>> {
        let results = self.db.chat_sessions().list_sessions(limit).await?;
        Ok(results
            .into_iter()
            .map(|db_session| db_session.into())
            .collect())
    }

    async fn end_session(&self, id: &str) -> ServiceResult<()> {
        let now = chrono::Utc::now();
        self.db.chat_sessions().end_session(id, now).await?;

        if let Some(ref callback) = self.mutation_callback {
            callback(ChatSessionMutationEvent::SessionUpdated { id: id.to_string() });
        }

        Ok(())
    }

    async fn update_title(&self, id: &str, title: &str) -> ServiceResult<()> {
        self.db.chat_sessions().update_title(id, title).await?;

        if let Some(ref callback) = self.mutation_callback {
            callback(ChatSessionMutationEvent::SessionUpdated { id: id.to_string() });
        }

        Ok(())
    }

    async fn add_message(&self, message: ChatMessage) -> ServiceResult<String> {
        let session_id_str = message.session_id.clone();
        let db_message = message.to_db();

        let msg_id = self.db.chat_sessions().add_message(&db_message).await?;

        if let Some(ref callback) = self.mutation_callback {
            callback(ChatSessionMutationEvent::MessageAdded {
                id: msg_id.clone(),
                session_id: session_id_str,
            });
        }

        Ok(msg_id)
    }

    async fn list_messages(&self, session_id: &str) -> ServiceResult<Vec<ChatMessage>> {
        let results = self.db.chat_sessions().list_messages(session_id).await?;
        Ok(results.into_iter().map(|db_msg| db_msg.into()).collect())
    }

    async fn get_session_content(&self, session_id: &str) -> ServiceResult<String> {
        self.db
            .chat_sessions()
            .get_session_content(session_id)
            .await
            .map_err(Into::into)
    }

    async fn delete_session(&self, id: &str) -> ServiceResult<()> {
        self.db.chat_sessions().delete_session(id).await?;

        if let Some(ref callback) = self.mutation_callback {
            callback(ChatSessionMutationEvent::SessionUpdated { id: id.to_string() });
        }

        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_create_session() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);
        let session = ChatSession::new(Some("/test/path".to_string()));

        let id = service.create_session(session).await.unwrap();
        assert!(!id.is_empty());

        // Verify we can retrieve it
        let retrieved = service.get_session(&id).await.unwrap();
        assert!(retrieved.is_some());
        assert_eq!(
            retrieved.unwrap().working_dir,
            Some("/test/path".to_string())
        );
    }

    #[tokio::test]
    async fn test_get_session() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);
        let session = ChatSession::new(Some("/test".to_string()));

        let id = service.create_session(session).await.unwrap();
        let retrieved = service.get_session(&id).await.unwrap();

        assert!(retrieved.is_some());
        assert_eq!(retrieved.unwrap().working_dir, Some("/test".to_string()));
    }

    #[tokio::test]
    async fn test_get_nonexistent_session() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);
        let result = service.get_session("nonexistent").await.unwrap();

        assert!(result.is_none());
    }

    #[tokio::test]
    async fn test_list_sessions() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);

        // Create multiple sessions
        for i in 0..3 {
            let session = ChatSession::new(None).with_title(format!("Session {}", i));
            service.create_session(session).await.unwrap();
        }

        let sessions = service.list_sessions(None).await.unwrap();
        assert_eq!(sessions.len(), 3);

        // Verify reverse chronological order
        assert_eq!(sessions[0].title, Some("Session 2".to_string()));
    }

    #[tokio::test]
    async fn test_list_sessions_with_limit() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);

        for i in 0..5 {
            let session = ChatSession::new(None).with_title(format!("Session {}", i));
            service.create_session(session).await.unwrap();
        }

        let sessions = service.list_sessions(Some(2)).await.unwrap();
        assert_eq!(sessions.len(), 2);
    }

    #[tokio::test]
    async fn test_end_session() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);
        let session = ChatSession::new(None);

        let id = service.create_session(session).await.unwrap();
        let retrieved = service.get_session(&id).await.unwrap().unwrap();
        assert!(retrieved.ended_at.is_none());

        service.end_session(&id).await.unwrap();

        let updated = service.get_session(&id).await.unwrap().unwrap();
        assert!(updated.ended_at.is_some());
    }

    #[tokio::test]
    async fn test_update_title() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);
        let session = ChatSession::new(None);

        let id = service.create_session(session).await.unwrap();
        service.update_title(&id, "New Title").await.unwrap();

        let updated = service.get_session(&id).await.unwrap().unwrap();
        assert_eq!(updated.title, Some("New Title".to_string()));
    }

    #[tokio::test]
    async fn test_add_and_list_messages() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);
        let session = ChatSession::new(None);

        let id = service.create_session(session).await.unwrap();

        // Add messages
        for i in 0..3 {
            let message = ChatMessage::new(&id, format!("Message {}", i));
            service.add_message(message).await.unwrap();
        }

        let messages = service.list_messages(&id).await.unwrap();
        assert_eq!(messages.len(), 3);
    }

    #[tokio::test]
    async fn test_get_session_content() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);
        let session = ChatSession::new(None);

        let id = service.create_session(session).await.unwrap();

        for content in ["Hello", " ", "World"] {
            let message = ChatMessage::new(&id, content);
            service.add_message(message).await.unwrap();
        }

        let content = service.get_session_content(&id).await.unwrap();
        assert_eq!(content, "Hello World");
    }

    #[tokio::test]
    async fn test_delete_session() {
        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let service = DefaultChatSessionService::new(db);
        let session = ChatSession::new(None);

        let id = service.create_session(session).await.unwrap();
        assert!(service.get_session(&id).await.unwrap().is_some());

        service.delete_session(&id).await.unwrap();

        assert!(service.get_session(&id).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn test_mutation_callback() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let db = Database::connect_mem().await.unwrap();
        db.init().await.unwrap();

        let call_count = Arc::new(AtomicUsize::new(0));
        let call_count_clone = Arc::clone(&call_count);

        let callback: ChatSessionMutationCallback = Arc::new(move |_event| {
            call_count_clone.fetch_add(1, Ordering::SeqCst);
        });

        let service = DefaultChatSessionService::with_callback(db, callback);
        let session = ChatSession::new(None);

        service.create_session(session).await.unwrap();
        assert_eq!(call_count.load(Ordering::SeqCst), 1);
    }
}
