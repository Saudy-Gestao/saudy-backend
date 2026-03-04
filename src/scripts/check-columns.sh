exec psql postgresql://postgres:postgres@localhost:5432/saudy_db -c "SELECT column_name FROM information_schema.columns WHERE table_name='branches' ORDER BY ordinal_position;"
