export interface VideoApiPrice {
  id: number;
  model: string;
  quality: string;
  bitrate: string;
  yuanPerSecond: number;
  pointsPerSecond: number;
}

export const videoApiPrices: VideoApiPrice[] = [
  { id: 1, model: 'Seedance 2.0', quality: '480p 标清', bitrate: 'High', yuanPerSecond: 0.352, pointsPerSecond: 35.2 },
  { id: 2, model: 'Seedance 2.0', quality: '720p 高清', bitrate: 'High', yuanPerSecond: 0.539, pointsPerSecond: 53.9 },
  { id: 3, model: 'Seedance 2.0', quality: '1080p 全高清', bitrate: 'High', yuanPerSecond: 1.298, pointsPerSecond: 129.8 },
  { id: 4, model: 'Seedance 2.0', quality: '4K 超高清', bitrate: 'High', yuanPerSecond: 2.662, pointsPerSecond: 266.2 },
  { id: 5, model: 'Seedance 2.0 Fast', quality: '480p 标清', bitrate: 'High', yuanPerSecond: 0.198, pointsPerSecond: 19.8 },
  { id: 6, model: 'Seedance 2.0 Fast', quality: '720p 高清', bitrate: 'High', yuanPerSecond: 0.418, pointsPerSecond: 41.8 },
  { id: 7, model: 'Seedance 2.0 Mini', quality: '480p 标清', bitrate: '—', yuanPerSecond: 0.132, pointsPerSecond: 13.2 },
  { id: 8, model: 'Seedance 2.0 Mini', quality: '720p 高清', bitrate: '—', yuanPerSecond: 0.297, pointsPerSecond: 29.7 },
  { id: 9, model: 'Seedance 2.5', quality: '480p 标清', bitrate: 'High', yuanPerSecond: 0.352, pointsPerSecond: 35.2 },
  { id: 10, model: 'Seedance 2.5', quality: '720p 高清', bitrate: 'High', yuanPerSecond: 0.792, pointsPerSecond: 79.2 },
  { id: 11, model: 'Seedance 2.5', quality: '1080p 全高清', bitrate: 'High', yuanPerSecond: 1.969, pointsPerSecond: 196.9 },
];
