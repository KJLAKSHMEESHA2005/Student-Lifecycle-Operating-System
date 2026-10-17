# Student Lifecycle OS ERD

```mermaid
erDiagram
    DEPARTMENTS ||--o{ PROGRAMS : owns
    DEPARTMENTS ||--o{ FACULTY : employs
    DEPARTMENTS ||--o{ COURSES : offers
    PROGRAMS ||--o{ STUDENTS : admits
    COURSES ||--o{ COURSE_PREREQUISITES : has
    COURSES ||--o{ COURSE_SECTIONS : scheduled_as
    ACADEMIC_TERMS ||--o{ COURSE_SECTIONS : contains
    FACULTY ||--o{ COURSE_SECTIONS : teaches
    COURSE_SECTIONS ||--o{ SECTION_MEETINGS : meets_at
    STUDENTS ||--o{ ENROLLMENTS : registers
    COURSE_SECTIONS ||--o{ ENROLLMENTS : roster
    COURSE_SECTIONS ||--o{ CLASS_SESSIONS : delivers
    ENROLLMENTS ||--o{ ATTENDANCE : records
    CLASS_SESSIONS ||--o{ ATTENDANCE : records_for
    COURSE_SECTIONS ||--o{ ASSESSMENTS : evaluates
    ASSESSMENTS ||--o{ ASSESSMENT_RESULTS : graded_as
    ENROLLMENTS ||--o{ ASSESSMENT_RESULTS : receives
    COURSE_SECTIONS ||--o{ COURSE_MATERIALS : publishes
    FACULTY ||--o{ COURSE_MATERIALS : uploads
    STUDENTS ||--o{ STUDENT_RECORDS : accumulates
    ACADEMIC_TERMS ||--o{ STUDENT_RECORDS : scopes

    DEPARTMENTS {
        int department_id PK
        string department_code UK
        string department_name UK
    }
    PROGRAMS {
        int program_id PK
        int department_id FK
        string program_code UK
        string program_name
    }
    STUDENTS {
        int student_id PK
        int program_id FK
        string roll_number UK
        string email UK
        int current_semester
        string status
    }
    FACULTY {
        int faculty_id PK
        int department_id FK
        string employee_number UK
        string email UK
    }
    COURSES {
        int course_id PK
        int department_id FK
        string course_code UK
        int credits
    }
    COURSE_SECTIONS {
        int section_id PK
        int course_id FK
        int term_id FK
        int faculty_id FK
        int capacity
    }
    ENROLLMENTS {
        int enrollment_id PK
        int student_id FK
        int section_id FK
        string status
        string final_grade
    }
    ATTENDANCE {
        int attendance_id PK
        int enrollment_id FK
        int session_id FK
        string attendance_status
    }
    ASSESSMENTS {
        int assessment_id PK
        int section_id FK
        decimal points_possible
        decimal weight_percent
    }
    ASSESSMENT_RESULTS {
        int result_id PK
        int assessment_id FK
        int enrollment_id FK
        decimal points_earned
    }
```

`course_prerequisites` is a recursive many-to-many relation between courses. `enrollments` resolves students to sections, and `assessment_results` resolves enrollments to assessments. Tables use generated primary keys and unique natural identifiers where useful.
