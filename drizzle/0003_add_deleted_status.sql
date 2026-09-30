ALTER TABLE `places` MODIFY COLUMN `status` enum('pending','approved','rejected','deleted') NOT NULL DEFAULT 'pending';
