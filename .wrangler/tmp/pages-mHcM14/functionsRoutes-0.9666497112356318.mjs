import { onRequestPost as __api_ai_ts_onRequestPost } from "/home/user/wander/functions/api/ai.ts"
import { onRequestGet as __api_geocode_ts_onRequestGet } from "/home/user/wander/functions/api/geocode.ts"
import { onRequestGet as __api_nearby_ts_onRequestGet } from "/home/user/wander/functions/api/nearby.ts"

export const routes = [
    {
      routePath: "/api/ai",
      mountPath: "/api",
      method: "POST",
      middlewares: [],
      modules: [__api_ai_ts_onRequestPost],
    },
  {
      routePath: "/api/geocode",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_geocode_ts_onRequestGet],
    },
  {
      routePath: "/api/nearby",
      mountPath: "/api",
      method: "GET",
      middlewares: [],
      modules: [__api_nearby_ts_onRequestGet],
    },
  ]