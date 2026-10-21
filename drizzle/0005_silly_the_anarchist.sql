CREATE TABLE `session_revocations` (
	`tokenHash` varchar(128) NOT NULL,
	`expiresAt` timestamp NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `session_revocations_tokenHash` PRIMARY KEY(`tokenHash`)
);
