import Axios from "axios";
import { createSlice } from "@reduxjs/toolkit";

export const userSlice = createSlice({
  name: "user",
  initialState: {
    user: {
      id_users: "",
      name: "",
      username: "",
      email: "",
      isAdmin: "",
      level: "",
      imagePath: "",
    },
  },
  reducers: {
    setUser: (state, action) => {
      state.user = action.payload;
    },
  },
});

export const { setUser } = userSlice.actions;
export default userSlice.reducer;

export function registerData(data) {
  return async (dispatch) => {
    let response = await Axios.post(
      "http://10.126.15.137:8002/part/register",
      data
    );
    if (response) {
      alert(response.data.message);
    }
  };
}

export function loginData(data) {
  return async (dispatch) => {
    let respons = await Axios.post(
      "http://10.126.15.137:8002/part/login",
      data
    );
    console.log(respons.data.token);
    dispatch(setUser(respons.data.data));
    localStorage.setItem("user_token", respons.data.token);
    if (respons) {
      alert(respons.data.message);
    }
  };
}

export function CheckLogin(token) {
  return async (dispatch) => {
    let respons = await Axios.post(
      "http://10.126.15.137:8002/part/check-Login",
      {},
      {
        headers: {
          authorization: `Bearer ${token}`,
        },
      }
    );
    if (respons) {
      dispatch(setUser(respons.data.data));
    }
  };
}
