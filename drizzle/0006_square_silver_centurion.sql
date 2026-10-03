CREATE TABLE `prediction_runtime_state` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text NOT NULL,
	`updated_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
