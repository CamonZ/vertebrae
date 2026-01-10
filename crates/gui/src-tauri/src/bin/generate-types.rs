//! Binary to generate TypeScript bindings from Rust types.
//!
//! Run with: cargo run --bin generate-types
//! Or via npm: npm run generate:types

fn main() {
    println!("Generating TypeScript bindings...");

    match gui_lib::export_bindings() {
        Ok(()) => {
            println!("Successfully generated bindings at src/bindings.ts");
        }
        Err(e) => {
            eprintln!("Failed to generate bindings: {}", e);
            std::process::exit(1);
        }
    }
}
