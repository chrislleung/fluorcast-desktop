mod nibi;
mod process;

use sqlx::sqlite::SqlitePoolOptions;
use tauri::{AppHandle, Manager};

#[tauri::command]
async fn delete_local_job_permanently(app: AppHandle, job_id: String) -> Result<bool, String> {
    let database_path = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("resolve app config directory failed: {error}"))?
        .join("fluorcast.db");
    let database_url = format!(
        "sqlite:{}",
        database_path
            .to_str()
            .ok_or_else(|| "resolve SQLite database path failed: non-UTF-8 path".to_string())?
    );
    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .connect(&database_url)
        .await
        .map_err(|error| format!("open SQLite database failed: {error}"))?;
    let mut transaction = pool
        .begin()
        .await
        .map_err(|error| format!("begin permanent local job delete transaction failed: {error}"))?;

    let existing_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM jobs WHERE id = ?")
        .bind(&job_id)
        .fetch_one(&mut *transaction)
        .await
        .map_err(|error| format!("check jobs row failed: {error}"))?;
    if existing_count == 0 {
        transaction.rollback().await.map_err(|error| {
            format!("rollback not-found permanent local job delete transaction failed: {error}")
        })?;
        return Ok(false);
    }

    sqlx::query("DELETE FROM job_events WHERE job_id = ?")
        .bind(&job_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("delete job_events rows failed: {error}"))?;
    sqlx::query("DELETE FROM results WHERE job_id = ?")
        .bind(&job_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("delete results row failed: {error}"))?;
    let deleted_job = sqlx::query("DELETE FROM jobs WHERE id = ?")
        .bind(&job_id)
        .execute(&mut *transaction)
        .await
        .map_err(|error| format!("delete jobs row failed: {error}"))?;

    transaction.commit().await.map_err(|error| {
        format!("commit permanent local job delete transaction failed: {error}")
    })?;

    Ok(deleted_job.rows_affected() > 0)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_sql::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            delete_local_job_permanently,
            nibi::end_manual_mfa_session,
            nibi::get_manual_mfa_session_commands,
            nibi::get_restricted_robot_public_key,
            nibi::open_manual_mfa_login,
            nibi::open_powershell_login,
            nibi::clean_stale_manual_mfa_session,
            nibi::persistent_shell_read,
            nibi::persistent_shell_send_input,
            nibi::persistent_shell_start,
            nibi::persistent_shell_status,
            nibi::persistent_shell_stop,
            nibi::persistent_shell_test_readiness,
            nibi::check_local_ssh_capabilities,
            nibi::test_manual_mfa_session,
            nibi::test_nibi_connection,
            nibi::test_robot_automation,
            nibi::run_nibi_remote_command,
            nibi::run_nibi_environment_checks,
            nibi::download_nibi_file,
            nibi::upload_nibi_file,
            nibi::prediction_output_temp_file_path,
            nibi::prediction_output_file_modified_at,
            nibi::read_prediction_output_file,
            nibi::write_prediction_input_temp_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running FluorCast");
}
