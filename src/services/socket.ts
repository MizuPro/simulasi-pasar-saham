//services/socket.ts

// Ini kode buat MENERIMA sambungan
import { Server } from "socket.io";

// Biasanya ini di-export function buat init server
let io: Server;

export const initSocket = (httpServer: any) => {
    io = new Server(httpServer, {
        cors: {
            origin: "*", // Bolehin frontend akses
        }
    });
    return io;
};

export const getIO = () => {
    if (!io) {
        throw new Error("Socket.io not initialized!");
    }
    return io;
};