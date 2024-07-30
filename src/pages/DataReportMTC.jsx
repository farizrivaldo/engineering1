import React, { useEffect, useState } from "react";
import moment from "moment/moment";
import {
  Stack,
  Table,
  Thead,
  Tbody,
  Tr,
  Th,
  Td,
  TableCaption,
  TableContainer,
  Button,
  Select,
} from "@chakra-ui/react";
import axios from "axios";

function DataReportMTC() {
  const [listData, setListData] = useState([]);

  const fetchData = async () => {
    let response = await axios.get(
      "http://10.126.15.141:8002/part/dataReportMTC"
    );
    setListData(response.data);
    console.log(response.data);
  };

  const renderListData = () => {
    return listData.map((users) => {
      return (
        <Tr>
          <Td>{users.id}</Td>
          <Td>{users.line}</Td>
          <Td>{users.proces}</Td>
          <Td>{users.machine}</Td>
          <Td>{moment(users.location).format("DD/MM/YYYY")}</Td>
          <Td>{users.pic}</Td>
          <Td>{users.tanggal}</Td>
          <Td>{users.start}</Td>
          <Td>{users.finish}</Td>
          <Td>{users.total}</Td>
          <Td>{users.sparepart}</Td>
          <Td>{users.quantity}</Td>
          <Td>{users.unit}</Td>
          <Td>{users.PMJob}</Td>
          <Td>{users.PMactual}</Td>
          <Td>{users.safety}</Td>
          <Td>{users.quality}</Td>
          <Td>{users.status}</Td>
          <Td>{users.jobDetail}</Td>
          <Td>{users.breakdown}</Td>
        </Tr>
      );
    });
  };

  return (
    <>
      <div>
        <h1 class="text-center text-4xl antialiased hover:subpixel-antialiased; p-8">
          REPORT MAINTAINANCE
        </h1>
      </div>

      <Stack
        className="flex flex-row justify-center   "
        direction="row"
        spacing={4}
        align="center"
      >
        <div className="main">
          <h1>Search Mesin</h1>
          <div className="search">
            <input
              id="outlined-basic"
              variant="outlined"
              fullWidth
              label="Search"
              className="block w-full rounded-md border-0 py-1.5 text-gray-900 shadow-sm ring-1 ring-inset ring-gray-300 placeholder:text-gray-400 focus:ring-2 focus:ring-inset focus:ring-indigo-600 sm:text-sm sm:leading-6"
            />
          </div>
        </div>

        <div>
          <h2>Month serch</h2>
          <Select placeholder="Select Mounth">
            <option value="1">Jan</option>
            <option value="2">Feb</option>
            <option value="3">Mar</option>
            <option value="4">Apr</option>
            <option value="5">Mei</option>
            <option value="6">Jun</option>
            <option value="7">Jul</option>
            <option value="8">Agu</option>
            <option value="9">Sep</option>
            <option value="10">Okt</option>
            <option value="11">Nov</option>
            <option value="12">Des</option>
          </Select>
        </div>

        <div>
          <h2>Line</h2>
          <Select placeholder="Select Line">
            <option value="Line4">FULL</option>
            <option value="Line1">Line 1</option>
            <option value="Line2">Line 2</option>
            <option value="Line3">Line 3</option>
            <option value="Line4">Line 4</option>
          </Select>
        </div>

        <div>
          <br />
          <Button
            className="w-40"
            colorScheme="blue"
            onClick={() => fetchData()}
          >
            Submit
          </Button>
        </div>
      </Stack>
      <br />
      <div>
        <TableContainer>
          <Table variant="simple">
            <Thead>
              <Tr>
                <Th>Id</Th>
                <Th>Line</Th>
                <Th>Process</Th>
                <Th>Machine</Th>
                <Th>Location</Th>
                <Th>PIC</Th>
                <Th>Tanggal</Th>
                <Th>Start</Th>
                <Th>Finish</Th>
                <Th>Total</Th>
                <Th>Sparepart</Th>
                <Th>Quantity</Th>
                <Th>Unit</Th>
                <Th>PMJob</Th>
                <Th>PMActual</Th>
                <Th>safety</Th>
                <Th>Quality</Th>
                <Th>Status</Th>
                <Th>JobDetail</Th>
                <Th>Breakdown</Th>
              </Tr>
            </Thead>
            <Tbody>{renderListData()}</Tbody>
          </Table>
        </TableContainer>
      </div>
    </>
  );
}

export default DataReportMTC;
