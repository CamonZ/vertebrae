//! Entry point for the Vertebrae TUI application.

use vertebrae_tui::{App, TuiResult};

#[tokio::main]
async fn main() -> TuiResult<()> {
    let mut app = App::new(None).await?;
    app.run().await
}
