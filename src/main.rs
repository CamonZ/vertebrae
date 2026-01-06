use clap::Parser;

/// Vertebrae - A task management CLI tool
#[derive(Parser)]
#[command(name = "vtb")]
#[command(version = "0.1.0")]
#[command(about = "A task management CLI tool", long_about = None)]
struct Args {
    /// Optional name to greet
    #[arg(short, long)]
    name: Option<String>,
}

fn main() {
    let args = Args::parse();

    if let Some(name) = args.name {
        println!("Hello, {}!", name);
    } else {
        println!("Welcome to Vertebrae!");
    }
}
