CREATE TABLE `readings` (
  `id` text PRIMARY KEY NOT NULL,
  `at` integer NOT NULL,
  `f` real NOT NULL
);
--> statement-breakpoint
CREATE INDEX `readings_at` ON `readings` (`at`);
--> statement-breakpoint
CREATE TABLE `monitor` (
  `id` integer PRIMARY KEY NOT NULL,
  `active` integer DEFAULT 0 NOT NULL,
  `started_at` integer,
  `ingest_hash` text
);
