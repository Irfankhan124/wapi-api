import 'dotenv/config';

const mongoUri =
  process.env.MONGO_URI ||
  process.env.MONGODB_URI ||
  process.env.MONGO_URL ||
  process.env.DATABASE_URL ||
  process.env.DB_URI ||
  '';

const config = {
  development: { mongoUri },
  production: { mongoUri },
  test: { mongoUri },
};

export default config;
