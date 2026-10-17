# Student Lifecycle OS

A centralized academic lifecycle system for a college or university. PostgreSQL is the source of truth for students, programs, faculty, terms, courses, sections, schedules, enrollments, attendance, assessments, materials, announcements, and student records. The student portal reads the relational model through a TypeScript API.

## Stack

- PostgreSQL 18: normalized transactional data, integrity constraints, indexes, views, and audit trail
- Express and TypeScript API
- React, TypeScript, and Vite frontend
- React Native with Expo for iOS and Android
- pgAdmin 4 for local database administration

## Run locally (Windows)

Prerequisites: Node.js 20.19+, PostgreSQL 18, and pgAdmin 4. Install PostgreSQL 18 locally.

```powershell
npm install
Copy-Item .env.example .env
# Create the campus login role and student_lifecycle database in pgAdmin 4.
# Set DATABASE_URL, STAFF_SIGNUP_CODE, and TOTP_ENCRYPTION_KEY in .env.
# Generate the 32-byte encryption key with:
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
npm run db:migrate
```

Set PostgreSQL's local connection in `.env` to port `5432`. Paste the generated 64-character hex key into `TOTP_ENCRYPTION_KEY`; keep this key backed up and private because authenticator secrets cannot be decrypted without it.

Open two project terminals:

```powershell
npm run dev:api
```

```powershell
npm run dev
```

Open `http://localhost:5173`. Staff can look up a student record by USN (Student ID). Students sign in with their USN and the password provisioned by staff. The application number is stored separately as `roll_number`. API health check: `http://localhost:3001/api/health`.

## Gemini academic assistant

Set `GEMINI_API_KEY` in the server-side `.env` file and optionally set `GEMINI_MODEL` (defaults to `gemini-2.5-flash`). Restart `npm run dev:api` after changing the environment. Signed-in students and staff can open **Assistant** from the sidebar. Only the chat conversation is sent to Google Gemini; student database records and credentials are not included. The chat is rate-limited, and provider keys stay on the server. If an API key has been shared in chat or another public place, revoke it and create a replacement.

On first launch, use **Sign up** to create the one staff account. Enter the staff name, email, a new password, and the private `STAFF_SIGNUP_CODE` from `.env`; registration closes after that first account. The password is stored as a hash. Staff can then sign in and use **Add student** in the portal. Application number and USN are required; email, admission date, and program code are optional. The form defaults current semester to 1.

The project contains no seeded student or academic records. Empty tables remain empty in the portal. Replace all placeholders in `.env`; do not use example credentials in production.

After staff sign-in, create a student record with an optional login password, or use **Set up login** beside an imported student with a USN. Students sign in with their USN; permanent passwords must be at least 12 characters. On first student login, scan the QR code with a TOTP authenticator that supports 60-second periods and confirm its current code. Subsequent logins require the password and a fresh six-digit authenticator code. Codes are single-use; authenticator secrets are encrypted at rest. Apply all migrations, including `009_student_authenticator.sql`, before provisioning student logins. Share initial passwords through a separate secure channel.

The web app is installable as a PWA on supported browsers. It caches only the application shell and static assets; sign-in and live academic data require a network connection. Use `localhost` for local web development or HTTPS when deployed.

## React Native app

The Expo client is in `mobile/` and uses OS secure storage for its bearer session. From the project root:

```powershell
npm install --prefix mobile
npm run dev:mobile
```

For an Android emulator, set `EXPO_PUBLIC_API_URL=http://10.0.2.2:3001`. For a physical device, use the computer's LAN IP and ensure both devices are on the same trusted network; use HTTPS outside local development. The native app supports student login, authenticator enrollment, courses, and upcoming assignments.

## Import a student roster

Export your spreadsheet as UTF-8 CSV with this exact header:

```text
roll_number,first_name,last_name,email,admission_date,current_semester,program_code
```

The header-only template is `database/templates/students.csv`. Dates must use `YYYY-MM-DD` when present; `roll_number`, `email`, `admission_date`, and `program_code` may be blank and are stored as `NULL`. The CSV importer requires supplied roll numbers and emails to be unique within that file. A supplied program code must already exist. Names and current semester are required. Keep the roster outside the project folder because it contains personal data.

For the SOE-MCA Excel roster, use the XLSX importer directly. It maps `Student Number` (application number) to `roll_number`, `Student ID` (USN) to `institution_student_id`, and `Section` to `academic_section`. Empty identifiers and emails are stored as `NULL`; shared email values are allowed. The importer splits the full name into first name and remaining name, and imports the workbook transactionally without duplicating it on a repeat run.

Validate the workbook without saving records, then import it:

```powershell
npm run db:import-students-xlsx -- "C:\path\to\SOE-MCA.xlsx" --dry-run
npm run db:import-students-xlsx -- "C:\path\to\SOE-MCA.xlsx"
```

The MCA roster importer sets `current_semester` to 1 when the workbook does not include a semester. Program and admission date remain unassigned if they are not supplied.

If you have a real program code, ensure its program exists before importing:

```sql
SELECT program_code, program_name FROM programs ORDER BY program_name;
```

If it is missing, open the `student_lifecycle` database in pgAdmin 4, launch Query Tool, and create the department using your college's actual details:

```sql
INSERT INTO departments (department_code, department_name)
VALUES ('<department-code>', '<actual department name>')
RETURNING department_id;
```

Use the returned ID to create the MCA program, filling in your college's real program code and curriculum credit total:

```sql
INSERT INTO programs (department_id, program_code, program_name, degree_level, standard_credits)
VALUES (<department-id>, '<MCA-program-code>', 'Master of Computer Applications', 'Postgraduate', <standard-credits>);
```

Put that exact program code in the relevant CSV rows. Leave `program_code` blank for students whose program is not recorded; the database will keep them unassigned instead of rejecting or guessing a program.

Then validate the file without saving rows:

```powershell
npm run db:import-students -- "C:\path\to\mca_students.csv" --dry-run
```

When validation succeeds, run the same command without `--dry-run`:

```powershell
npm run db:import-students -- "C:\path\to\mca_students.csv"
```

The import is transactional: any invalid row or database uniqueness conflict rolls back the entire batch. It never overwrites existing students. After import, enter a student's USN in the portal to view their record.
## Import a class timetable

The Excel timetable importer preserves non-empty worksheet cell values and merged-cell ranges, then records each scheduled class and break. It does not guess course or faculty IDs from labels in the workbook.

Validate a workbook without saving it:

```powershell
npm run db:import-timetable -- "C:\path\to\class_timetable.xlsx" --dry-run
```

When validation succeeds, import it:

```powershell
npm run db:import-timetable -- "C:\path\to\class_timetable.xlsx"
```

Imports are transactional and identical workbooks are detected by SHA-256, so rerunning the command does not duplicate timetable entries. The source sheet is stored in `timetable_imports`; parsed classes and breaks are stored in `timetable_entries`.

## Database deliverables

- `database/migrations/001_initial_schema.sql`: normalized schema and database logic
- `database/migrations/002_optional_student_admission_fields.sql`: permits students without an admission date or assigned program
- `database/migrations/003_optional_student_identifiers.sql`: permits missing roll numbers and email addresses
- `database/migrations/005_timetable_imports.sql`: stores uploaded timetable workbooks and schedule entries
- `database/migrations/006_student_roster_imports.sql`: stores institutional IDs, sections, and roster import provenance
- `database/migrations/008_student_accounts.sql`: student accounts and expiring sessions
- `database/migrations/009_student_authenticator.sql`: encrypted TOTP enrollment and replay state
- `database/templates/students.csv`: empty roster import template
- `database/adbms_queries.sql`: query and transaction workbook
- `docs/ERD.md`: relationship diagram

The model separates reference entities from lifecycle events. Join tables represent many-to-many relationships; foreign keys, unique and check constraints enforce domain integrity. Attendance and gradebook data are derived in views rather than stored as duplicated summaries.

ADBMS topics demonstrated: normalization, referential integrity, indexes for common access paths, analytical views, CTEs, window functions, `EXPLAIN ANALYZE`, transactional schema migration, row-lock-based seat allocation, cross-section attendance validation, and JSONB audit snapshots.

## Verify

```powershell
npm run build
npm run lint
```

Authentication, authorization, production secret management, and student self-service write APIs are outside this demonstration build and should be added before deployment.
Staff and student APIs use separate expiring sessions. Academic dashboard lookups require staff authentication; student dashboard requests are scoped to the signed-in student. Configure HTTPS, backups, account recovery, and production secret management before deployment.
